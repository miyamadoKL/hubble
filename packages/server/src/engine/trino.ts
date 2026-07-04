/**
 * Trino データソース向け QueryEngine 実装。
 *
 * 用途別 TrinoClient（user/metadata/scheduled/download）を内包し、
 * 既存の MetadataSource、EXPLAIN 見積もり、VALIDATE 検証の振る舞いを維持する。
 */
import type {
  Catalog,
  DatasourceCapabilities,
  EstimateResult,
  SampleRowsResponse,
  SchemaItem,
  TableDetail,
  TableItem,
} from '@hubble/contracts';
import { TrinoQueryError } from '../errors';
import type { ServerConfig } from '../config';
import { capabilitiesForKind } from '../datasource/summary';
import type { ResolvedTrinoDatasource } from '../datasource/types';
import { MetadataSource } from '../metadata/source';
import { DOWNLOAD_SOURCE } from '../query/csv';
import type { ValidationResult } from '../schedule/validator';
import { TrinoClient } from '../trino/client';
import { runToCompletion } from '../trino/runner';
import type { TrinoRequestContext } from '../trino/types';
import { runTrinoEstimate } from './trinoEstimate';
import type {
  DownloadClientOptions,
  EngineEstimateParams,
  EngineValidateParams,
  EstimateGuardConfig,
  ExecutionClientOptions,
  QueryEngine,
  StatementClient,
} from './types';

/** TrinoEngine 構築オプション。 */
export interface TrinoEngineOptions {
  datasource: ResolvedTrinoDatasource;
  /** trino-default フォールバック時の環境変数由来ソースタグ。 */
  trinoConfig: ServerConfig['trino'];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** X-Trino-Source タグ一式。 */
export interface TrinoSourceTags {
  user: string;
  metadata: string;
  scheduled: string;
  download: string;
}

/**
 * データソースと設定から X-Trino-Source タグを導出する。
 * trino-default のみ既存 TRINO_* 環境変数の値をそのまま使う（後方互換）。
 *
 * @param datasource - 解決済み Trino データソース。
 * @param trinoConfig - loadServerConfig() の trino セクション。
 * @returns 用途別ソースタグ。
 */
export function deriveTrinoSourceTags(
  datasource: ResolvedTrinoDatasource,
  trinoConfig: ServerConfig['trino'],
): TrinoSourceTags {
  if (datasource.id === 'trino-default') {
    return {
      user: trinoConfig.source,
      metadata: trinoConfig.metadataSource,
      scheduled: trinoConfig.scheduledSource,
      download: DOWNLOAD_SOURCE,
    };
  }
  return {
    user: datasource.source,
    metadata: `${datasource.source}-metadata`,
    scheduled: `${datasource.source}-scheduled`,
    download: `${datasource.source}-download`,
  };
}

function createTrinoClient(
  datasource: ResolvedTrinoDatasource,
  trinoConfig: ServerConfig['trino'],
  source: string,
  options: Pick<TrinoEngineOptions, 'fetchImpl' | 'sleepImpl'>,
): TrinoClient {
  return new TrinoClient({
    baseUrl: datasource.baseUrl,
    username: datasource.username,
    password: datasource.password,
    user: trinoConfig.user,
    source,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });
}

/**
 * Trino 向け QueryEngine を構築する。
 * @param options - データソースと Trino 設定。
 * @returns TrinoEngine 実装。
 */
export function createTrinoEngine(options: TrinoEngineOptions): QueryEngine {
  const { datasource, trinoConfig } = options;
  const tags = deriveTrinoSourceTags(datasource, trinoConfig);
  const capabilities: DatasourceCapabilities = capabilitiesForKind('trino');

  const userClient = createTrinoClient(datasource, trinoConfig, tags.user, options);
  const metadataClient = createTrinoClient(datasource, trinoConfig, tags.metadata, options);
  const scheduledClient = createTrinoClient(datasource, trinoConfig, tags.scheduled, options);
  const downloadClient = createTrinoClient(datasource, trinoConfig, tags.download, options);
  const metadata = new MetadataSource(metadataClient, tags.metadata);
  let closed = false;

  return {
    datasourceId: datasource.id,
    kind: 'trino',
    capabilities,

    executionClient(opts: ExecutionClientOptions): StatementClient {
      const client = opts.source === 'scheduled' ? scheduledClient : userClient;
      return wrapClientWithUser(client, opts.user);
    },

    downloadClient(opts: DownloadClientOptions = {}): StatementClient {
      return wrapClientWithUser(downloadClient, opts.user);
    },

    ioExplainExecution(params: EngineEstimateParams) {
      return {
        client: metadataClient,
        ctx: {
          catalog: params.catalog,
          schema: params.schema,
          source: tags.metadata,
          user: params.principal,
        },
      };
    },

    async estimate(
      params: EngineEstimateParams,
      guard: EstimateGuardConfig,
    ): Promise<EstimateResult> {
      const ctx: TrinoRequestContext = {
        catalog: params.catalog,
        schema: params.schema,
        source: tags.metadata,
        user: params.principal,
      };
      return runTrinoEstimate(params.statement, ctx, {
        client: metadataClient,
        metadataSource: tags.metadata,
        estimateTimeoutMs: guard.estimateTimeoutMs,
        bytesPerSecond: guard.bytesPerSecond,
        limits: {
          mode: guard.mode,
          maxScanBytes: guard.maxScanBytes,
          maxScanRows: guard.maxScanRows,
          onUnknown: guard.onUnknown,
        },
        now: options.now,
      });
    },

    async validate(params: EngineValidateParams): Promise<ValidationResult> {
      const ctx: TrinoRequestContext = {
        catalog: params.catalog ?? undefined,
        schema: params.schema ?? undefined,
        source: tags.scheduled,
        user: params.principal,
      };
      try {
        await runToCompletion(scheduledClient, `EXPLAIN (TYPE VALIDATE) ${params.statement}`, ctx);
        return { ok: true };
      } catch (err) {
        if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
          const loc = err.trino.errorLocation;
          const result: ValidationResult = {
            ok: false,
            kind: 'user_error',
            message: err.trino.message,
          };
          if (loc?.lineNumber && loc.lineNumber > 0) result.line = loc.lineNumber;
          if (loc?.columnNumber && loc.columnNumber > 0) result.column = loc.columnNumber;
          return result;
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, kind: 'unavailable', message };
      }
    },

    listCatalogs(): Promise<Catalog[]> {
      return metadata.fetchCatalogs();
    },
    listSchemas(catalog: string): Promise<SchemaItem[]> {
      return metadata.fetchSchemas(catalog);
    },
    listTables(catalog: string, schema: string): Promise<TableItem[]> {
      return metadata.fetchTables(catalog, schema);
    },
    describeTable(catalog: string, schema: string, table: string): Promise<TableDetail> {
      return metadata.fetchColumns(catalog, schema, table).then((columns) => ({
        catalog,
        schema,
        name: table,
        columns,
      }));
    },
    sampleTable(
      catalog: string,
      schema: string,
      table: string,
      limit?: number,
    ): Promise<SampleRowsResponse> {
      return metadata.fetchSample(catalog, schema, table, limit);
    },

    isClosed(): boolean {
      return closed;
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}

/**
 * impersonation 用に X-Trino-User を上書きしたクライアントラッパーを返す。
 * user 省略時は元のクライアントをそのまま返す。
 */
function wrapClientWithUser(client: TrinoClient, user?: string): StatementClient {
  if (user === undefined) return client;
  return {
    start: (statement, ctx, mutations, signal) =>
      client.start(statement, { ...ctx, user }, mutations, signal),
    advance: (nextUri, ctx, mutations, signal) =>
      client.advance(nextUri, { ...ctx, user }, mutations, signal),
    cancel: (nextUri, ctx) => client.cancel(nextUri, { ...ctx, user }),
    waitBackoff: (attempt, signal) => client.waitBackoff(attempt, signal),
  };
}

/**
 * PostgreSQL データソース向け QueryEngine 実装。
 */
import type {
  Catalog,
  DatasourceCapabilities,
  SampleRowsResponse,
  SchemaItem,
  TableDetail,
  TableItem,
} from '@hubble/contracts';
import { AppError } from '../../errors';
import { capabilitiesForKind } from '../../datasource/summary';
import type { ResolvedPostgresqlDatasource } from '../../datasource/types';
import type { ValidationResult } from '../../schedule/validator';
import { ignoreMetadataPrincipal } from '../types';
import type {
  DownloadClientOptions,
  EngineValidateParams,
  ExecutionClientOptions,
  MetadataOptions,
  QueryEngine,
  StatementClient,
} from '../types';
import { pgTableRef } from '../sql/identifiers';
import { throwPgDriverError } from '../sql/errors';
import { selectSqlCredential } from '../sql/roleCredentials';
import { validateWithExplain } from '../sql/validate';
import { createPgPool, type PgPool, type PgPoolFactory } from './pool';
import { createPgStatementClient } from './statementClient';
import { runToCompletion } from '../../trino/runner';

export interface PostgresqlEngineOptions {
  datasource: ResolvedPostgresqlDatasource;
  poolFactory?: PgPoolFactory;
  operationTimeoutMs?: number;
}

/**
 * PostgreSQL 向け QueryEngine を構築する。
 * @param options - データソースとテスト用プールファクトリ。
 * @returns QueryEngine 実装。
 */
export function createPostgresqlEngine(options: PostgresqlEngineOptions): QueryEngine {
  const { datasource } = options;
  const poolFactory = options.poolFactory ?? createPgPool;
  const pools = new Map<string, PgPool>();
  const capabilities: DatasourceCapabilities = capabilitiesForKind('postgresql');
  const catalogNames = new Map<string, string>();
  let closed = false;

  const poolForRole = (roleName: string | undefined): { poolKey: string; pool: PgPool } => {
    const credential = selectSqlCredential(datasource, roleName);
    const existing = pools.get(credential.poolKey);
    if (existing !== undefined) return { poolKey: credential.poolKey, pool: existing };
    const pool = poolFactory({
      ...datasource,
      username: credential.username,
      password: credential.password,
    });
    pools.set(credential.poolKey, pool);
    return { poolKey: credential.poolKey, pool };
  };
  poolForRole(undefined);

  const loadCatalogName = async (roleName: string | undefined): Promise<string> => {
    const { poolKey, pool } = poolForRole(roleName);
    const catalogName = catalogNames.get(poolKey);
    if (catalogName !== undefined) return catalogName;
    try {
      const res = await pool.query<{ name: string }>('SELECT current_database() AS name');
      const name = res.rows[0]?.name ?? datasource.database;
      catalogNames.set(poolKey, name);
      return name;
    } catch (err) {
      throwPgDriverError(err);
    }
  };

  const assertCatalog = async (catalog: string, roleName: string | undefined): Promise<void> => {
    const expected = await loadCatalogName(roleName);
    if (catalog !== expected) {
      throw AppError.notFound(`Catalog ${catalog} not found`);
    }
  };

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    roleName?: string,
  ): Promise<T[]> => {
    try {
      const res = await poolForRole(roleName).pool.query<T>(sql, params);
      return res.rows;
    } catch (err) {
      throwPgDriverError(err, sql);
    }
  };

  return {
    datasourceId: datasource.id,
    kind: 'postgresql',
    capabilities,

    async probe(signal?: AbortSignal): Promise<void> {
      const client = createPgStatementClient(poolForRole(undefined).pool, {
        datasourceReadOnly: datasource.readOnly,
        sessionReadOnly: true,
      });
      await runToCompletion(
        client,
        'SELECT 1',
        {},
        { timeoutMs: options.operationTimeoutMs ?? 3000, signal },
      );
    },

    executionClient(opts: ExecutionClientOptions): StatementClient {
      return createPgStatementClient(poolForRole(opts.roleName).pool, {
        datasourceReadOnly: datasource.readOnly,
        sessionReadOnly: opts.sessionReadOnly ?? false,
      });
    },

    downloadClient(opts: DownloadClientOptions = {}): StatementClient {
      return createPgStatementClient(poolForRole(opts.roleName).pool, {
        datasourceReadOnly: datasource.readOnly,
        sessionReadOnly: opts.sessionReadOnly ?? false,
      });
    },

    async estimate(): Promise<never> {
      throw AppError.badRequest(
        `Datasource ${datasource.id} does not support cost estimation`,
        'ESTIMATE_NOT_SUPPORTED',
      );
    },

    async validate(params: EngineValidateParams): Promise<ValidationResult> {
      return validateWithExplain(
        async (sql) => {
          const client = createPgStatementClient(poolForRole(params.roleName).pool, {
            datasourceReadOnly: datasource.readOnly,
            sessionReadOnly: true,
          });
          await runToCompletion(client, sql, {}, { timeoutMs: options.operationTimeoutMs ?? 3000 });
        },
        params.statement,
        'postgresql',
      );
    },

    async listCatalogs(opts: MetadataOptions): Promise<Catalog[]> {
      ignoreMetadataPrincipal(opts);
      return [{ name: await loadCatalogName(opts.roleName) }];
    },

    async listSchemas(catalog: string, opts: MetadataOptions): Promise<SchemaItem[]> {
      ignoreMetadataPrincipal(opts);
      await assertCatalog(catalog, opts.roleName);
      const rows = await query<{ schema_name: string }>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT LIKE 'pg_toast%'
           AND schema_name NOT LIKE 'pg_temp%'
         ORDER BY schema_name`,
        [],
        opts.roleName,
      );
      return rows.map((r) => ({ name: r.schema_name }));
    },

    async listTables(catalog: string, schema: string, opts: MetadataOptions): Promise<TableItem[]> {
      ignoreMetadataPrincipal(opts);
      await assertCatalog(catalog, opts.roleName);
      const rows = await query<{ table_name: string; table_type: string }>(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = $1 AND table_type IN ('BASE TABLE','VIEW')
         ORDER BY table_name`,
        [schema],
        opts.roleName,
      );
      return rows.map((r) => ({ name: r.table_name, type: r.table_type }));
    },

    async describeTable(
      catalog: string,
      schema: string,
      table: string,
      opts: MetadataOptions,
    ): Promise<TableDetail> {
      ignoreMetadataPrincipal(opts);
      await assertCatalog(catalog, opts.roleName);
      const rows = await query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table],
        opts.roleName,
      );
      return {
        catalog,
        schema,
        name: table,
        columns: rows.map((r) => ({ name: r.column_name, type: r.data_type })),
      };
    },

    isClosed(): boolean {
      return closed;
    },

    async close(): Promise<void> {
      closed = true;
      await Promise.all([...pools.values()].map((pool) => pool.end()));
    },

    async sampleTable(
      catalog: string,
      schema: string,
      table: string,
      limit: number | undefined,
      opts: MetadataOptions,
    ): Promise<SampleRowsResponse> {
      ignoreMetadataPrincipal(opts);
      await assertCatalog(catalog, opts.roleName);
      const ref = pgTableRef(schema, table);
      const safeLimit = Math.max(1, Math.min(limit ?? 10, 1000));
      try {
        const client = await poolForRole(opts.roleName).pool.connect();
        try {
          const res = await client.query({
            text: `SELECT * FROM ${ref} LIMIT $1`,
            values: [safeLimit],
            rowMode: 'array',
          });
          const columns = res.fields.map((f) => ({
            name: f.name,
            type: PG_OID_TYPES[f.dataTypeID] ?? 'unknown',
          }));
          return {
            columns,
            rows: res.rows as unknown[][],
            source: 'live',
          };
        } finally {
          client.release();
        }
      } catch (err) {
        throwPgDriverError(err);
      }
    },
  };
}

const PG_OID_TYPES: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  23: 'integer',
  25: 'text',
  1043: 'varchar',
  1184: 'timestamptz',
};

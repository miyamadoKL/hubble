/**
 * MySQL/PostgreSQL 向けの未実装スタブエンジン（Phase 3 で置き換え）。
 *
 * datasources.yaml に mysql/postgresql を書いても起動は成功し、一覧には出るが
 * 実行やメタデータ取得は 501 で明確にエラーを返す。
 */
import type {
  Catalog,
  DatasourceCapabilities,
  DatasourceKind,
  EstimateResult,
  SampleRowsResponse,
  SchemaItem,
  TableDetail,
  TableItem,
} from '@hubble/contracts';
import { AppError } from '../errors';
import type { ValidationResult } from '../schedule/validator';
import { capabilitiesForKind } from '../datasource/summary';
import type {
  EngineEstimateParams,
  EngineValidateParams,
  EstimateGuardConfig,
  QueryEngine,
  StatementClient,
} from './types';

const NOT_IMPLEMENTED_MSG =
  'This datasource kind is not supported yet (planned for Phase 3)';

/** 未対応操作で throw するスタブ StatementClient。 */
class UnsupportedStatementClient implements StatementClient {
  async start(): Promise<never> {
    throw AppError.notImplemented(NOT_IMPLEMENTED_MSG);
  }
  async advance(): Promise<never> {
    throw AppError.notImplemented(NOT_IMPLEMENTED_MSG);
  }
  async cancel(): Promise<void> {
    // 開始前キャンセル相当。何もしない。
  }
  async waitBackoff(): Promise<void> {
    throw AppError.notImplemented(NOT_IMPLEMENTED_MSG);
  }
}

/**
 * 未対応データソース種別用のスタブ QueryEngine を構築する。
 * @param datasourceId - データソース id。
 * @param kind - mysql または postgresql。
 * @returns 全操作が 501 を返すエンジン。
 */
export function createUnsupportedEngine(datasourceId: string, kind: DatasourceKind): QueryEngine {
  const capabilities: DatasourceCapabilities = capabilitiesForKind(kind);
  const client = new UnsupportedStatementClient();

  const notImplemented = (): never => {
    throw AppError.notImplemented(NOT_IMPLEMENTED_MSG);
  };

  return {
    datasourceId,
    kind,
    capabilities,
    executionClient(): StatementClient {
      return client;
    },
    downloadClient(): StatementClient {
      return client;
    },
    estimate(params: EngineEstimateParams, guard: EstimateGuardConfig): Promise<EstimateResult> {
      void params;
      void guard;
      return Promise.resolve(notImplemented());
    },
    validate(params: EngineValidateParams): Promise<ValidationResult> {
      void params;
      return Promise.resolve(notImplemented());
    },
    listCatalogs(): Promise<Catalog[]> {
      return Promise.resolve(notImplemented());
    },
    listSchemas(catalog: string): Promise<SchemaItem[]> {
      void catalog;
      return Promise.resolve(notImplemented());
    },
    listTables(catalog: string, schema: string): Promise<TableItem[]> {
      void catalog;
      void schema;
      return Promise.resolve(notImplemented());
    },
    describeTable(catalog: string, schema: string, table: string): Promise<TableDetail> {
      void catalog;
      void schema;
      void table;
      return Promise.resolve(notImplemented());
    },
    sampleTable(catalog: string, schema: string, table: string, limit?: number): Promise<SampleRowsResponse> {
      void catalog;
      void schema;
      void table;
      void limit;
      return Promise.resolve(notImplemented());
    },
  };
}
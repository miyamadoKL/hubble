/**
 * MySQL データソース向け QueryEngine 実装。
 *
 * StatementClient 模倣で QueryRegistry/SSE/CSV を無改修で動かし、
 * メタデータは Trino mysql connector と同型の 2 階層(database → table)写像で返す。
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
import type { ResolvedMysqlDatasource } from '../../datasource/types';
import type { ValidationResult } from '../../schedule/validator';
import type {
  EngineValidateParams,
  ExecutionClientOptions,
  QueryEngine,
  StatementClient,
} from '../types';
import { mysqlTableRef } from '../sql/identifiers';
import { throwMysqlDriverError } from '../sql/errors';
import { validateWithExplain } from '../sql/validate';
import { createMysqlPool, type MysqlPoolFactory } from './pool';
import { createMysqlStatementClient } from './statementClient';

export interface MysqlEngineOptions {
  datasource: ResolvedMysqlDatasource;
  poolFactory?: MysqlPoolFactory;
}

/**
 * MySQL 向け QueryEngine を構築する。
 * @param options - データソースとテスト用プールファクトリ。
 * @returns QueryEngine 実装。
 */
export function createMysqlEngine(options: MysqlEngineOptions): QueryEngine {
  const { datasource } = options;
  const poolFactory = options.poolFactory ?? createMysqlPool;
  const pool = poolFactory(datasource);
  const capabilities: DatasourceCapabilities = capabilitiesForKind('mysql');
  const syntheticCatalog = datasource.id;

  const assertCatalog = (catalog: string): void => {
    if (catalog !== syntheticCatalog) {
      throw AppError.notFound(`Catalog ${catalog} not found`);
    }
  };

  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    try {
      const [rows] = await pool.query({ sql, rowsAsArray: false }, params);
      return rows as T[];
    } catch (err) {
      throwMysqlDriverError(err);
    }
  };

  const engine: QueryEngine = {
    datasourceId: datasource.id,
    kind: 'mysql',
    capabilities,

    executionClient(opts: ExecutionClientOptions): StatementClient {
      return createMysqlStatementClient(pool, {
        datasourceReadOnly: datasource.readOnly,
        sessionReadOnly: opts.sessionReadOnly ?? false,
      });
    },

    downloadClient(): StatementClient {
      return createMysqlStatementClient(pool, {
        datasourceReadOnly: datasource.readOnly,
        sessionReadOnly: false,
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
          await query(sql);
        },
        params.statement,
        'mysql',
      );
    },

    async listCatalogs(): Promise<Catalog[]> {
      return [{ name: syntheticCatalog }];
    },

    async listSchemas(catalog: string): Promise<SchemaItem[]> {
      assertCatalog(catalog);
      const rows = await query<{ SCHEMA_NAME: string }>(
        `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
         WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys')
         ORDER BY SCHEMA_NAME`,
      );
      return rows.map((r) => ({ name: r.SCHEMA_NAME }));
    },

    async listTables(catalog: string, schema: string): Promise<TableItem[]> {
      assertCatalog(catalog);
      const rows = await query<{ TABLE_NAME: string; TABLE_TYPE: string }>(
        `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE','VIEW')
         ORDER BY TABLE_NAME`,
        [schema],
      );
      return rows.map((r) => ({ name: r.TABLE_NAME, type: r.TABLE_TYPE }));
    },

    async describeTable(catalog: string, schema: string, table: string): Promise<TableDetail> {
      assertCatalog(catalog);
      const rows = await query<{
        COLUMN_NAME: string;
        DATA_TYPE: string;
        COLUMN_COMMENT: string | null;
      }>(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_COMMENT FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [schema, table],
      );
      return {
        catalog,
        schema,
        name: table,
        columns: rows.map((r) => ({
          name: r.COLUMN_NAME,
          type: r.DATA_TYPE,
          comment: r.COLUMN_COMMENT ?? undefined,
        })),
      };
    },

    async sampleTable(
      catalog: string,
      schema: string,
      table: string,
      limit = 10,
    ): Promise<SampleRowsResponse> {
      assertCatalog(catalog);
      const ref = mysqlTableRef(schema, table);
      const safeLimit = Math.max(1, Math.min(limit, 1000));
      try {
        const [rows, fields] = await pool.query(
          { sql: `SELECT * FROM ${ref} LIMIT ?`, rowsAsArray: true },
          [safeLimit],
        );
        const columns = (fields as { name: string; type?: string }[]).map((f) => ({
          name: f.name,
          type: f.type ?? 'unknown',
        }));
        return {
          columns,
          rows: rows as unknown[][],
          source: 'live',
        };
      } catch (err) {
        throwMysqlDriverError(err);
      }
    },
  };

  return engine;
}

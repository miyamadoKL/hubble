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
import type {
  DownloadClientOptions,
  EngineValidateParams,
  ExecutionClientOptions,
  QueryEngine,
  StatementClient,
} from '../types';
import { pgTableRef } from '../sql/identifiers';
import { throwPgDriverError } from '../sql/errors';
import { validateWithExplain } from '../sql/validate';
import { createPgPool, type PgPoolFactory } from './pool';
import { createPgStatementClient } from './statementClient';

export interface PostgresqlEngineOptions {
  datasource: ResolvedPostgresqlDatasource;
  poolFactory?: PgPoolFactory;
}

/**
 * PostgreSQL 向け QueryEngine を構築する。
 * @param options - データソースとテスト用プールファクトリ。
 * @returns QueryEngine 実装。
 */
export function createPostgresqlEngine(options: PostgresqlEngineOptions): QueryEngine {
  const { datasource } = options;
  const poolFactory = options.poolFactory ?? createPgPool;
  const pool = poolFactory(datasource);
  const capabilities: DatasourceCapabilities = capabilitiesForKind('postgresql');
  let catalogName: string | undefined;
  let closed = false;

  const loadCatalogName = async (): Promise<string> => {
    if (catalogName !== undefined) return catalogName;
    try {
      const res = await pool.query<{ name: string }>('SELECT current_database() AS name');
      catalogName = res.rows[0]?.name ?? datasource.database;
      return catalogName;
    } catch (err) {
      throwPgDriverError(err);
    }
  };

  const assertCatalog = async (catalog: string): Promise<void> => {
    const expected = await loadCatalogName();
    if (catalog !== expected) {
      throw AppError.notFound(`Catalog ${catalog} not found`);
    }
  };

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    try {
      const res = await pool.query<T>(sql, params);
      return res.rows;
    } catch (err) {
      throwPgDriverError(err, sql);
    }
  };

  return {
    datasourceId: datasource.id,
    kind: 'postgresql',
    capabilities,

    executionClient(opts: ExecutionClientOptions): StatementClient {
      return createPgStatementClient(pool, {
        datasourceReadOnly: datasource.readOnly,
        sessionReadOnly: opts.sessionReadOnly ?? false,
      });
    },

    downloadClient(opts: DownloadClientOptions = {}): StatementClient {
      return createPgStatementClient(pool, {
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
          await query(sql);
        },
        params.statement,
        'postgresql',
      );
    },

    async listCatalogs(): Promise<Catalog[]> {
      return [{ name: await loadCatalogName() }];
    },

    async listSchemas(catalog: string): Promise<SchemaItem[]> {
      await assertCatalog(catalog);
      const rows = await query<{ schema_name: string }>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT LIKE 'pg_toast%'
           AND schema_name NOT LIKE 'pg_temp%'
         ORDER BY schema_name`,
      );
      return rows.map((r) => ({ name: r.schema_name }));
    },

    async listTables(catalog: string, schema: string): Promise<TableItem[]> {
      await assertCatalog(catalog);
      const rows = await query<{ table_name: string; table_type: string }>(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = $1 AND table_type IN ('BASE TABLE','VIEW')
         ORDER BY table_name`,
        [schema],
      );
      return rows.map((r) => ({ name: r.table_name, type: r.table_type }));
    },

    async describeTable(catalog: string, schema: string, table: string): Promise<TableDetail> {
      await assertCatalog(catalog);
      const rows = await query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table],
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
      await pool.end();
    },

    async sampleTable(
      catalog: string,
      schema: string,
      table: string,
      limit = 10,
    ): Promise<SampleRowsResponse> {
      await assertCatalog(catalog);
      const ref = pgTableRef(schema, table);
      const safeLimit = Math.max(1, Math.min(limit, 1000));
      try {
        const client = await pool.connect();
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

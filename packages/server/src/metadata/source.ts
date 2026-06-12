import type {
  Catalog,
  Column,
  SampleRowsResponse,
  SchemaItem,
  TableItem,
} from '@hue-fable/contracts';
import type { TrinoClient } from '../trino/client';
import { runToCompletion } from '../trino/runner';
import type { TrinoColumn, TrinoRequestContext } from '../trino/types';

/** Double-quote-escape a Trino identifier. */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Single-quote-escape a Trino string literal. */
function quoteString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function toStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Trino-backed metadata source. Reads `system.metadata.catalogs` and
 * `information_schema` (design.md §3). All queries use the metadata source tag.
 */
export class MetadataSource {
  constructor(
    private readonly client: TrinoClient,
    private readonly source: string,
  ) {}

  private ctx(extra?: Partial<TrinoRequestContext>): TrinoRequestContext {
    return { source: this.source, ...extra };
  }

  async fetchCatalogs(): Promise<Catalog[]> {
    const { rows } = await runToCompletion(
      this.client,
      'SELECT catalog_name FROM system.metadata.catalogs ORDER BY catalog_name',
      this.ctx(),
    );
    return rows.map((r) => ({ name: toStr(r[0]) }));
  }

  async fetchSchemas(catalog: string): Promise<SchemaItem[]> {
    const { rows } = await runToCompletion(
      this.client,
      `SELECT schema_name FROM ${quoteIdent(catalog)}.information_schema.schemata ORDER BY schema_name`,
      this.ctx(),
    );
    return rows.map((r) => ({ name: toStr(r[0]) }));
  }

  async fetchTables(catalog: string, schema: string): Promise<TableItem[]> {
    const { rows } = await runToCompletion(
      this.client,
      `SELECT table_name, table_type FROM ${quoteIdent(catalog)}.information_schema.tables ` +
        `WHERE table_schema = ${quoteString(schema)} ORDER BY table_name`,
      this.ctx(),
    );
    return rows.map((r) => {
      const item: TableItem = { name: toStr(r[0]) };
      const type = toStr(r[1]);
      if (type) item.type = type;
      return item;
    });
  }

  async fetchColumns(catalog: string, schema: string, table: string): Promise<Column[]> {
    const { rows } = await runToCompletion(
      this.client,
      `SELECT column_name, data_type, comment FROM ${quoteIdent(catalog)}.information_schema.columns ` +
        `WHERE table_schema = ${quoteString(schema)} AND table_name = ${quoteString(table)} ` +
        `ORDER BY ordinal_position`,
      this.ctx(),
    );
    return rows.map((r) => {
      const col: Column = { name: toStr(r[0]), type: toStr(r[1]) };
      const comment = r[2];
      if (comment !== null && comment !== undefined && toStr(comment) !== '') {
        col.comment = toStr(comment);
      }
      return col;
    });
  }

  /** Sample up to `limit` rows from a table (default 10). */
  async fetchSample(
    catalog: string,
    schema: string,
    table: string,
    limit = 10,
  ): Promise<SampleRowsResponse> {
    const statement = `SELECT * FROM ${quoteIdent(catalog)}.${quoteIdent(schema)}.${quoteIdent(
      table,
    )} LIMIT ${limit}`;
    const { columns, rows } = await runToCompletion(this.client, statement, this.ctx());
    return {
      columns: toColumns(columns),
      rows,
      source: 'live',
    };
  }
}

function toColumns(columns: TrinoColumn[]): Column[] {
  return columns.map((c) => ({ name: c.name, type: c.type }));
}

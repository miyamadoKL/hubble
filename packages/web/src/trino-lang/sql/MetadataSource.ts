// Part of the hubble trino-lang fork (see repo-root NOTICE for the
// trino-query-ui Apache-2.0 attribution covering the surrounding modules).
//
// MetadataSource replaces the forked singleton `SchemaProvider`, which issued
// SQL directly against Trino. Metadata is now supplied through this DI'd
// interface; the web app injects a contracts-based API-client implementation
// (backed by TanStack Query's fetchQuery cache). Keeping it an interface lets
// tests pass a trivial in-memory mock and keeps the language layer free of any
// transport concern.

import Column from '../schema/Column';
import Table from '../schema/Table';

/** A metadata column as returned by the `/api/.../tables/:t` contract. */
export interface MetadataColumn {
  name: string;
  type: string;
  comment?: string;
}

/** Fully-resolved table detail (columns) for a single table. */
export interface MetadataTable {
  catalog: string;
  schema: string;
  name: string;
  comment?: string;
  columns: MetadataColumn[];
}

/**
 * Async metadata provider injected into the language layer. All methods are
 * expected to be cached/deduplicated by the implementation (the web app uses
 * `queryClient.fetchQuery`), so the language layer may call them freely.
 */
export interface MetadataSource {
  listCatalogs(): Promise<string[]>;
  listSchemas(catalog: string): Promise<string[]>;
  listTables(catalog: string, schema: string): Promise<string[]>;
  getTable(catalog: string, schema: string, table: string): Promise<MetadataTable | undefined>;
}

/** Build a fork `Table` value object (with `Column`s) from a `MetadataTable`. */
export function toForkTable(detail: MetadataTable): Table {
  const table = new Table(detail.name);
  const columns = table.getColumns();
  for (const col of detail.columns) {
    columns.push(new Column(col.name, col.type, '', col.comment ?? ''));
  }
  return table;
}

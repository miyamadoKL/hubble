// Part of the trino-lang module.
//
// MetadataSource replaces the forked singleton `SchemaProvider`, which issued
// SQL directly against Trino. Metadata is now supplied through this DI'd
// interface; the web app injects a contracts-based API-client implementation
// (backed by TanStack Query's fetchQuery cache). Keeping it an interface lets
// tests pass a trivial in-memory mock and keeps the language layer free of any
// transport concern.
//
// 日本語: MetadataSource は、以前は Trino に直接 SQL を発行していたシングルトン
// `SchemaProvider`（フォーク元の実装）を置き換えるものである。メタデータは現在
// この DI 可能なインターフェース経由で供給される。web アプリ側は contracts ベースの
// API クライアント実装（TanStack Query の fetchQuery キャッシュを裏で使う）を注入する。
// インターフェースとして定義することで、テストは単純なインメモリのモックを渡せるし、
// 言語処理層（trino-lang）は通信手段の詳細から切り離される。

import Column from '../schema/Column';
import Table from '../schema/Table';

/**
 * A metadata column as returned by the `/api/.../tables/:t` contract.
 *
 * `/api/.../tables/:t` の contract から返ってくるカラムメタデータの形。
 */
export interface MetadataColumn {
  name: string;
  type: string;
  comment?: string;
}

/**
 * Fully-resolved table detail (columns) for a single table.
 *
 * 1 テーブル分の、カラムまで解決済みのテーブル詳細情報。
 */
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
 *
 * 言語処理層に注入される非同期メタデータプロバイダー。各メソッドは実装側で
 * キャッシュ/重複排除されることが期待されている（web アプリでは
 * `queryClient.fetchQuery` を使う）ため、言語処理層は気兼ねなく自由に呼び出せる。
 */
export interface MetadataSource {
  listCatalogs(): Promise<string[]>;
  listSchemas(catalog: string): Promise<string[]>;
  listTables(catalog: string, schema: string): Promise<string[]>;
  getTable(catalog: string, schema: string, table: string): Promise<MetadataTable | undefined>;
}

/**
 * Build a fork `Table` value object (with `Column`s) from a `MetadataTable`.
 *
 * MetadataSource から得た `MetadataTable`（DTO）を、schema/ 配下の `Table` 値
 * オブジェクト（`Column` 群を含む）に変換する。SchemaCache がテーブル解決時に呼ぶ。
 */
export function toForkTable(detail: MetadataTable): Table {
  const table = new Table(detail.name);
  const columns = table.getColumns();
  // comment 以外のフィールド（extra）はここでは扱わないため空文字で埋める。
  for (const col of detail.columns) {
    columns.push(new Column(col.name, col.type, '', col.comment ?? ''));
  }
  return table;
}

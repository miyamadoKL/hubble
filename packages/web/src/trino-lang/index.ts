// Public surface of the trino-lang module. The editor layer (../editor/) and
// tests import from here rather than reaching into individual modules.
//
// ---- ファイル概要（日本語） ----
// trino-lang モジュールの公開 API（エントリーポイント）。エディター層（../editor/）
// やテストコードは、analyzer.ts / splitStatements.ts / sql/ / schema/ 配下の各
// モジュールを直接 import せず、必ずこの index.ts 経由で参照する。こうすることで
// trino-lang 内部のファイル構成（どのクラスがどのファイルにあるか）を自由に変更
// できる状態を保ち、外部から見える API 表面を単一箇所で管理できる。

// 構文解析（parseStatement）と補完候補収集（collectCompletions）まわりの型と関数。
export {
  parseStatement,
  collectCompletions,
  type ParseResult,
  type CompletionContext,
  type CompletionCandidate,
  type TrinoSqlMarker,
  type HighlightDescriptor,
} from './analyzer';
// マルチステートメントの SQL をセミコロン区切りで分割するユーティリティ（実行ガター用）。
export { splitStatements, type StatementSlice } from './splitStatements';
// 非同期メタデータソースの同期的な読み取りキャッシュ。
export { SchemaCache } from './sql/SchemaCache';
// メタデータ供給のための DI インターフェースと DTO 型。
export { type MetadataSource, type MetadataTable, type MetadataColumn } from './sql/MetadataSource';
// ANTLR トークン種別 → Monaco ハイライトスコープの対応表。
export { tokenMap } from './sql/TokenMap';
// スキーマモデル（カタログ→スキーマ→テーブル→カラム）のうち、外部から直接
// 使われる値オブジェクトのみを再エクスポートする。
export { default as TableReference } from './schema/TableReference';
export { default as Table } from './schema/Table';
export { default as Column } from './schema/Column';

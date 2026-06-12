// Public surface of the trino-lang module. The editor layer (../editor/) and
// tests import from here rather than reaching into individual modules.

export {
  parseStatement,
  collectCompletions,
  type ParseResult,
  type CompletionContext,
  type CompletionCandidate,
  type TrinoSqlMarker,
  type HighlightDescriptor,
} from './analyzer';
export { splitStatements, type StatementSlice } from './splitStatements';
export { SchemaCache } from './sql/SchemaCache';
export { type MetadataSource, type MetadataTable, type MetadataColumn } from './sql/MetadataSource';
export { tokenMap } from './sql/TokenMap';
export { default as TableReference } from './schema/TableReference';
export { default as Table } from './schema/Table';
export { default as Column } from './schema/Column';

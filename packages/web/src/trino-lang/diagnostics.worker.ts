/** SQL 構文解析をメインスレッド外で実行する Worker。 */
import { parseStatement } from './analyzer';

interface DiagnosticsRequest {
  sql: string;
  catalog?: string;
  schema?: string;
}

self.onmessage = (event: MessageEvent<DiagnosticsRequest>) => {
  const result = parseStatement(event.data.sql, event.data.catalog, event.data.schema);
  self.postMessage({
    markers: result.markers,
    descriptors: result.descriptors,
    tableReferences: result.tableReferences.map((reference) => ({
      catalogName: reference.catalogName,
      schemaName: reference.schemaName,
      tableName: reference.tableName,
    })),
  });
};

/** SQL 診断 Worker の生成、応答、世代キャンセルを扱うクライアント。 */
import { parseStatement, type ParseResult } from './analyzer';
import TableReference from './schema/TableReference';

interface DiagnosticsInput {
  sql: string;
  catalog?: string;
  schema?: string;
}

interface WorkerResult extends Omit<ParseResult, 'tableReferences'> {
  tableReferences: Array<{ catalogName: string; schemaName: string; tableName: string }>;
}

/** 開始済みの解析処理。cancel は Worker を終了し、応答を破棄する。 */
export interface DiagnosticsTask {
  promise: Promise<ParseResult>;
  cancel: () => void;
}

/** 一件の構文解析を Worker で開始する。DOM のないテスト環境では同期実装へ戻す。 */
export function startDiagnostics(input: DiagnosticsInput): DiagnosticsTask {
  if (typeof Worker === 'undefined') {
    return {
      promise: Promise.resolve(parseStatement(input.sql, input.catalog, input.schema)),
      cancel: () => {},
    };
  }

  const worker = new Worker(new URL('./diagnostics.worker.ts', import.meta.url), {
    type: 'module',
  });
  let rejectTask: ((reason: unknown) => void) | undefined;
  const promise = new Promise<ParseResult>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      worker.terminate();
      resolve({
        markers: event.data.markers,
        descriptors: event.data.descriptors,
        tableReferences: event.data.tableReferences.map(
          (reference) =>
            new TableReference(reference.catalogName, reference.schemaName, reference.tableName),
        ),
      });
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
  });
  worker.postMessage(input);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      rejectTask?.(new DOMException('Diagnostics canceled', 'AbortError'));
    },
  };
}

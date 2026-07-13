/**
 * クエリ結果を serializer 非依存のイベント列として読み出す。
 *
 * CSV、xlsx、外部エクスポートが同じ行ソース解決を使えるように、メモリ上の
 * `QueryExecution`、保存済み zstd JSONL、再実行クエリを `columns` と `row`
 * のイベントへ正規化する。
 */
import type { QueryColumn } from '@hubble/contracts';
import type { DownloadClientOptions, StatementClient } from '../engine/types';
import { AppError } from '../errors';
import {
  emptySessionMutations,
  toQueryColumns,
  type TrinoRequestContext,
  type TrinoColumn,
} from '../trino/types';
import type { QueryExecution } from './execution';
import { DOWNLOAD_SOURCE, needsCsvReexec, statementAllowsCsvReexec } from './csv';
import { statementPages } from '../engine/statementDriver';
import { raceSqlAbort } from '../engine/sql/abort';

/** クエリ結果の列定義または 1 行を表すイベント。 */
export type QueryResultEvent =
  | { type: 'columns'; columns: QueryColumn[] }
  | { type: 'row'; row: unknown[] };

/** 即時のイベント列、または消費開始時にイベント列を開く factory。 */
export type QueryResultEventInput =
  | AsyncGenerator<QueryResultEvent>
  | ((
      signal?: AbortSignal,
    ) => AsyncGenerator<QueryResultEvent> | Promise<AsyncGenerator<QueryResultEvent>>);

/** lazy factory の場合だけ現在の消費対象を開く。 */
export async function openQueryResultEvents(
  input: QueryResultEventInput,
  signal?: AbortSignal,
): Promise<AsyncGenerator<QueryResultEvent>> {
  if (typeof input !== 'function') return input;
  const pending = Promise.resolve(input(signal));
  return raceSqlAbort(pending, signal, () => {
    // factory が中断後に完了しても、開いた入力を未消費のまま残さない。
    void pending.then(
      (events) => events.return(undefined).catch(() => undefined),
      () => undefined,
    );
  });
}

/** 行イベントストリームの取得元。監査 detail やレスポンスに使う。 */
export type QueryResultEventSource = 'buffer' | 'bufferedPartial' | 'resultStore' | 'reexec';

/** 再実行を含む行ソース取得で必要な依存。 */
export interface QueryResultEventDeps {
  /** 再実行クエリの発行に使うステートメントクライアント。 */
  client?: StatementClient;
  /** ダウンロード用クライアント生成時のオプション（client 省略時のみ使用）。 */
  downloadClientOptions?: DownloadClientOptions;
  /** HTTP クライアント切断などを伝える signal。 */
  signal?: AbortSignal;
}

/** メモリ上の実行から読むか再実行するかを判定してイベントストリームを返す。 */
export function streamQueryResultEvents(
  exec: QueryExecution,
  deps: QueryResultEventDeps,
): {
  source: QueryResultEventSource;
  events: AsyncGenerator<QueryResultEvent>;
} {
  const needsReexec = needsCsvReexec(exec);
  const allowsReexec = statementAllowsCsvReexec(exec);
  if (!needsReexec) return { source: 'buffer', events: streamBufferedEvents(exec) };
  if (!allowsReexec) return { source: 'bufferedPartial', events: streamBufferedEvents(exec) };
  if (exec.engine.isClosed()) {
    throw AppError.csvReexecUnavailable(
      'Full export requires re-execution but the original datasource connection is no longer available.',
    );
  }
  return { source: 'reexec', events: streamReexecEvents(exec, deps) };
}

/** バッファ済み行をイベントとして読む。実行中の場合は追加行を追随する。 */
export async function* streamBufferedEvents(
  exec: QueryExecution,
): AsyncGenerator<QueryResultEvent> {
  await waitForColumnsOrTerminal(exec);
  yield { type: 'columns', columns: exec.columns };

  let index = 0;
  for (;;) {
    const row = exec.rowAt(index);
    if (row !== undefined) {
      yield { type: 'row', row };
      index += 1;
      continue;
    }
    if (exec.isTerminal && index >= exec.bufferedCount) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function resolveReexecClient(exec: QueryExecution, deps: QueryResultEventDeps): StatementClient {
  return deps.client ?? exec.downloadClient(deps.downloadClientOptions);
}

/** 読み取り確認済みステートメントを再実行し、受信ページを行イベントへ変換する。 */
async function* streamReexecEvents(
  exec: QueryExecution,
  deps: QueryResultEventDeps,
): AsyncGenerator<QueryResultEvent> {
  const client = resolveReexecClient(exec, deps);
  const { signal } = deps;
  const ctx: TrinoRequestContext = { ...exec.ctx, source: DOWNLOAD_SOURCE };
  const mutations = emptySessionMutations();

  let columnsWritten = false;
  const writeColumns = async function* (
    columns: TrinoColumn[] | undefined,
  ): AsyncGenerator<QueryResultEvent> {
    if (columnsWritten || columns === undefined) return;
    columnsWritten = true;
    yield { type: 'columns', columns: toQueryColumns(columns) };
  };

  for await (const page of statementPages({
    client,
    statement: exec.statement,
    ctx,
    mutations,
    signal,
  })) {
    yield* writeColumns(page.columns);
    for (const row of page.data ?? []) yield { type: 'row', row };
  }
  if (!columnsWritten) yield { type: 'columns', columns: [] };
}

function waitForColumnsOrTerminal(exec: QueryExecution): Promise<void> {
  if (exec.columns.length > 0 || exec.isTerminal) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = exec.subscribe((event) => {
      if (event.type === 'columns' || event.type === 'done') {
        unsubscribe();
        resolve();
      }
    });
    if (exec.columns.length > 0 || exec.isTerminal) {
      unsubscribe();
      resolve();
    }
  });
}

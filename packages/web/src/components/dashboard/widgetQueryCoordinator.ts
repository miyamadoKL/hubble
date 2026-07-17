/**
 * Dashboard query widget の共有実行と同時実行数を管理する。
 * 同じ savedQueryId の widget は一つの実行状態を購読し、表示中の dashboard
 * 全体では固定数を超える query を同時に開始しない。
 */
import type { QueryColumn, QuerySnapshot, SavedQuery } from '@hubble/contracts';
import { QueryClient, QueryObserver, type QueryObserverResult } from '@tanstack/react-query';
import PQueue from 'p-queue';
import { getSavedQuery } from '../../api/savedQueries';
import { cancelQuery, createQuery, fetchQueryRows, fetchQuerySnapshot } from '../../execution/api';
import type { ResultRow } from '../../execution';

const WIDGET_MAX_ROWS = 1000;
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 120_000;
const CANCEL_SETTLE_TIMEOUT_MS = 2_000;

/** dashboard 一つで同時に実行する widget query の上限。 */
export const DASHBOARD_QUERY_CONCURRENCY = 4;

/** widget に公開する共有 query 状態。 */
export interface SharedWidgetQueryState {
  loading: boolean;
  error: string | null;
  columns: QueryColumn[];
  rows: ResultRow[];
  queryName: string | null;
}

/** widget query 実行で使う外部 API。 */
export interface WidgetQueryApi {
  getSavedQuery: (id: string, signal?: AbortSignal) => Promise<SavedQuery>;
  createQuery: typeof createQuery;
  fetchQuerySnapshot: (queryId: string, signal?: AbortSignal) => Promise<QuerySnapshot>;
  fetchQueryRows: typeof fetchQueryRows;
  cancelQuery: (queryId: string) => Promise<void>;
  now: () => number;
  wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

const defaultApi: WidgetQueryApi = {
  getSavedQuery,
  createQuery,
  fetchQuerySnapshot,
  fetchQueryRows,
  cancelQuery,
  now: Date.now,
  wait: abortableDelay,
};

/** AbortSignal に応答する polling 待機。 */
function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** signal の中断理由を Error として返す。 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Widget query was canceled', 'AbortError');
}

/** 中断済みなら後続 API を開始せず例外にする。 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** 保存済み query を一度実行して表示用の結果を返す。 */
export async function executeWidgetQuery(
  savedQueryId: string,
  signal: AbortSignal,
  api: WidgetQueryApi = defaultApi,
  onQueryName?: (queryName: string) => void,
): Promise<Omit<SharedWidgetQueryState, 'loading' | 'error'>> {
  let activeQueryId: string | null = null;
  let cancelPromise: Promise<void> | null = null;
  const cancelActive = (): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    const queryId = activeQueryId;
    activeQueryId = null;
    if (queryId === null) return Promise.resolve();
    cancelPromise = api.cancelQuery(queryId).catch(() => undefined);
    return cancelPromise;
  };
  const onAbort = () => {
    void cancelActive();
  };
  signal.addEventListener('abort', onAbort);
  try {
    const savedQuery = await api.getSavedQuery(savedQueryId, signal);
    throwIfAborted(signal);
    onQueryName?.(savedQuery.name);
    // POST は応答から queryId を得るまで中断せず、取得後の cancel 境界を維持する。
    const { queryId } = await api.createQuery({
      statement: savedQuery.statement,
      catalog: savedQuery.catalog ?? undefined,
      schema: savedQuery.schema ?? undefined,
      datasourceId: savedQuery.datasourceId ?? undefined,
      maxRows: WIDGET_MAX_ROWS,
    });
    activeQueryId = queryId;
    throwIfAborted(signal);

    const deadline = api.now() + POLL_TIMEOUT_MS;
    let snapshot = await api.fetchQuerySnapshot(queryId, signal);
    while (!isTerminal(snapshot)) {
      throwIfAborted(signal);
      if (api.now() > deadline) throw new Error('Query timed out');
      await api.wait(POLL_INTERVAL_MS, signal);
      snapshot = await api.fetchQuerySnapshot(queryId, signal);
    }
    activeQueryId = null;
    throwIfAborted(signal);
    if (snapshot.state !== 'finished') {
      throw new Error(snapshot.error?.message ?? `Query ${snapshot.state}`);
    }

    const page = await api.fetchQueryRows(queryId, 0, WIDGET_MAX_ROWS, signal);
    throwIfAborted(signal);
    return {
      queryName: savedQuery.name,
      columns: snapshot.columns ?? [],
      rows: page.rows,
    };
  } catch (error) {
    // cancel 失敗より、query 実行または polling の元エラーを優先する。
    await waitForCancellation(cancelActive());
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** cancel が永続停止しても dashboard queue 全体を止めない範囲で解放を待つ。 */
async function waitForCancellation(canceling: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      canceling,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CANCEL_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** query snapshot がこれ以上進行しない状態かを返す。 */
function isTerminal(snapshot: QuerySnapshot): boolean {
  return (
    snapshot.state === 'finished' || snapshot.state === 'failed' || snapshot.state === 'canceled'
  );
}

/** 本番 API を使い、coordinator の進捗 callback へ query 名を渡す既定 executor。 */
const defaultExecutor = (
  savedQueryId: string,
  signal: AbortSignal,
  onQueryName?: (queryName: string) => void,
) => executeWidgetQuery(savedQueryId, signal, defaultApi, onQueryName);

type Listener = (state: SharedWidgetQueryState) => void;
type QueryResult = Omit<SharedWidgetQueryState, 'loading' | 'error'>;
type WidgetQueryKey = readonly ['dashboard-widget', string];
const emptyQueryResult: QueryResult = { columns: [], rows: [], queryName: null };

function toSharedState(result: QueryObserverResult<QueryResult>): SharedWidgetQueryState {
  return {
    loading: result.isPending || result.isFetching,
    error:
      result.isFetching || !result.error
        ? null
        : result.error instanceof Error
          ? result.error.message
          : String(result.error),
    columns: result.data?.columns ?? [],
    rows: result.data?.rows ?? [],
    queryName: result.data?.queryName ?? null,
  };
}

/** TanStack Queryを状態所有者、p-queueをdashboard内の同時実行制御として使う。 */
export class DashboardQueryCoordinator {
  private readonly executor: (
    savedQueryId: string,
    signal: AbortSignal,
    onQueryName?: (queryName: string) => void,
  ) => Promise<QueryResult>;
  private readonly queryClient: QueryClient;
  private readonly queue: PQueue;
  private disposed = false;
  private ownerEpoch = 0;

  constructor(maxConcurrency = DASHBOARD_QUERY_CONCURRENCY, executor = defaultExecutor) {
    this.executor = executor;
    this.queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Infinity,
          refetchOnMount: false,
          refetchOnReconnect: false,
          refetchOnWindowFocus: false,
          retry: false,
          staleTime: Infinity,
        },
      },
    });
    this.queue = new PQueue({ concurrency: maxConcurrency });
  }

  /** StrictMode の effect 再 setup で同じ owner が coordinator を再利用可能にする。 */
  activate(): void {
    if (this.disposed) throw new Error('Disposed dashboard query coordinator cannot be reused');
    this.ownerEpoch += 1;
  }

  /** StrictMode の疑似 cleanup を越えた実 unmount の場合だけ破棄する。 */
  scheduleDispose(): void {
    const ownerEpoch = this.ownerEpoch;
    queueMicrotask(() => {
      if (this.ownerEpoch === ownerEpoch) this.dispose();
    });
  }

  /** savedQueryId の共有状態を購読し、解除関数を返す。 */
  subscribe(savedQueryId: string, listener: Listener): () => void {
    if (this.disposed) throw new Error('Dashboard query coordinator is disposed');
    const queryKey: WidgetQueryKey = ['dashboard-widget', savedQueryId];
    const observer = new QueryObserver<QueryResult>(this.queryClient, {
      queryFn: ({ signal }) => {
        this.queryClient.setQueryData<QueryResult>(
          queryKey,
          (current) => current ?? emptyQueryResult,
        );
        return this.queue.add(
          ({ signal: queueSignal }) =>
            this.executor(savedQueryId, queueSignal ?? signal, (queryName) => {
              this.queryClient.setQueryData<QueryResult>(queryKey, (current) => ({
                columns: current?.columns ?? [],
                rows: current?.rows ?? [],
                queryName,
              }));
            }),
          { signal },
        );
      },
      queryKey,
    });
    const notify = (result: QueryObserverResult<QueryResult> = observer.getCurrentResult()) => {
      if (!this.disposed) listener(toSharedState(result));
    };
    notify();
    const unsubscribe = observer.subscribe(notify);
    return () => {
      unsubscribe();
      observer.destroy();
    };
  }

  /** 同じ savedQueryId を購読する全 widget の query を再実行する。 */
  refresh(savedQueryId: string): void {
    if (this.disposed) return;
    void this.queryClient.refetchQueries(
      { queryKey: ['dashboard-widget', savedQueryId], type: 'active' },
      { cancelRefetch: true },
    );
  }

  /** dashboard 破棄時に queue と全 active query を終了する。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ownerEpoch += 1;
    this.queue.pause();
    const canceling = this.queryClient.cancelQueries();
    this.queryClient.clear();
    void canceling.then(
      () => this.queue.clear(),
      () => this.queue.clear(),
    );
  }
}

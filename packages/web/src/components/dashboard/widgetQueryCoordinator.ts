/**
 * Dashboard query widget の共有実行と同時実行数を管理する。
 * 同じ savedQueryId の widget は一つの実行状態を購読し、表示中の dashboard
 * 全体では固定数を超える query を同時に開始しない。
 */
import type { QueryColumn, QuerySnapshot, SavedQuery } from '@hubble/contracts';
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

type Listener = (state: SharedWidgetQueryState) => void;
type EntryStatus = 'idle' | 'queued' | 'running';

interface QueryEntry {
  savedQueryId: string;
  state: SharedWidgetQueryState;
  listeners: Set<Listener>;
  status: EntryStatus;
  controller: AbortController | null;
  version: number;
  rerun: boolean;
}

const initialState = (): SharedWidgetQueryState => ({
  loading: true,
  error: null,
  columns: [],
  rows: [],
  queryName: null,
});

/** 本番 API を使い、coordinator の進捗 callback へ query 名を渡す既定 executor。 */
const defaultExecutor = (
  savedQueryId: string,
  signal: AbortSignal,
  onQueryName?: (queryName: string) => void,
) => executeWidgetQuery(savedQueryId, signal, defaultApi, onQueryName);

/** dashboard 単位で query の共有、queue、cancel を管理する。 */
export class DashboardQueryCoordinator {
  private readonly maxConcurrency: number;
  private readonly executor: (
    savedQueryId: string,
    signal: AbortSignal,
    onQueryName?: (queryName: string) => void,
  ) => Promise<Omit<SharedWidgetQueryState, 'loading' | 'error'>>;
  private readonly entries = new Map<string, QueryEntry>();
  private readonly queue: QueryEntry[] = [];
  private activeCount = 0;
  private disposed = false;
  private lifecycle = 0;
  private ownerEpoch = 0;

  constructor(maxConcurrency = DASHBOARD_QUERY_CONCURRENCY, executor = defaultExecutor) {
    this.maxConcurrency = maxConcurrency;
    this.executor = executor;
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
    let entry = this.entries.get(savedQueryId);
    if (!entry) {
      entry = {
        savedQueryId,
        state: initialState(),
        listeners: new Set(),
        status: 'idle',
        controller: null,
        version: 0,
        rerun: false,
      };
      this.entries.set(savedQueryId, entry);
    }
    entry.listeners.add(listener);
    listener(entry.state);
    if (entry.state.loading) this.enqueue(entry);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      entry!.listeners.delete(listener);
      if (entry!.listeners.size > 0) return;
      if (entry!.status === 'running') entry!.controller?.abort();
      if (entry!.status === 'queued') entry!.status = 'idle';
      if (entry!.state.loading && entry!.status !== 'running') {
        this.entries.delete(savedQueryId);
      }
    };
  }

  /** 同じ savedQueryId を購読する全 widget の query を再実行する。 */
  refresh(savedQueryId: string): void {
    const entry = this.entries.get(savedQueryId);
    if (!entry) return;
    entry.state = { ...entry.state, loading: true, error: null };
    this.notify(entry);
    if (entry.status === 'running') {
      entry.rerun = true;
      entry.controller?.abort();
      return;
    }
    this.enqueue(entry);
  }

  /** dashboard 破棄時に queue と全 active query を終了する。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ownerEpoch += 1;
    this.lifecycle += 1;
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      entry.listeners.clear();
    }
    this.entries.clear();
    this.queue.length = 0;
    this.activeCount = 0;
  }

  /** idle entry を実行 queue へ一度だけ追加する。 */
  private enqueue(entry: QueryEntry): void {
    if (this.disposed || entry.listeners.size === 0 || entry.status !== 'idle') return;
    entry.status = 'queued';
    this.queue.push(entry);
    this.pump();
  }

  /** concurrency 枠が空いている間だけ queue を開始する。 */
  private pump(): void {
    while (!this.disposed && this.activeCount < this.maxConcurrency) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.status !== 'queued' || entry.listeners.size === 0) continue;
      this.start(entry);
    }
  }

  /** entry 一件を開始し、完了後に次の queue を処理する。 */
  private start(entry: QueryEntry): void {
    const controller = new AbortController();
    const version = ++entry.version;
    const lifecycle = this.lifecycle;
    entry.status = 'running';
    entry.controller = controller;
    this.activeCount += 1;

    void this.executor(entry.savedQueryId, controller.signal, (queryName) => {
      if (
        this.disposed ||
        this.lifecycle !== lifecycle ||
        entry.version !== version ||
        controller.signal.aborted
      ) {
        return;
      }
      entry.state = { ...entry.state, queryName };
      this.notify(entry);
    })
      .then((result) => {
        if (
          this.disposed ||
          this.lifecycle !== lifecycle ||
          entry.version !== version ||
          controller.signal.aborted
        ) {
          return;
        }
        entry.state = { loading: false, error: null, ...result };
        this.notify(entry);
      })
      .catch((error: unknown) => {
        if (
          this.disposed ||
          this.lifecycle !== lifecycle ||
          entry.version !== version ||
          controller.signal.aborted
        ) {
          return;
        }
        entry.state = {
          ...entry.state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        };
        this.notify(entry);
      })
      .finally(() => {
        if (this.lifecycle !== lifecycle) return;
        this.activeCount -= 1;
        if (entry.controller === controller) entry.controller = null;
        if (entry.status === 'running') entry.status = 'idle';
        if (this.disposed) return;
        const rerun = entry.rerun;
        entry.rerun = false;
        if (entry.listeners.size === 0) {
          if (entry.state.loading) this.entries.delete(entry.savedQueryId);
        } else if (rerun || controller.signal.aborted) {
          entry.state = { ...entry.state, loading: true, error: null };
          this.notify(entry);
          this.enqueue(entry);
        }
        this.pump();
      });
  }

  /** 現在の state を購読中 widget へ同期通知する。 */
  private notify(entry: QueryEntry): void {
    for (const listener of entry.listeners) listener(entry.state);
  }
}

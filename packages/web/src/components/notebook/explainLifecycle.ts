/**
 * EXPLAIN 副問い合わせの queryId、世代、購読、キャンセル、終端を一か所で所有する。
 */
import type { CreateQueryRequest, QueryEvent, QueryRowsPage } from '@hubble/contracts';
import type { SseHandlers, SseSubscription } from '../../execution/sse';
import { SseProtocolError } from '../../execution/sse';

/** EXPLAIN ライフサイクルが利用する外部操作。 */
export interface ExplainLifecycleDependencies {
  createQuery: (request: CreateQueryRequest) => Promise<{ queryId: string }>;
  cancelQuery: (queryId: string) => Promise<void>;
  fetchQueryRows: (queryId: string, offset: number, limit: number) => Promise<QueryRowsPage>;
  subscribeQueryEvents: (queryId: string, handlers: SseHandlers) => SseSubscription;
}

/** 現在世代の表示状態だけを更新するコールバック。 */
export interface ExplainLifecycleCallbacks {
  setRunning: (running: boolean) => void;
  setText: (text: string | undefined) => void;
}

interface ExplainOperation {
  generation: number;
  callbacks: ExplainLifecycleCallbacks;
  queryId?: string;
  subscription?: SseSubscription;
  remoteCancelIssued: boolean;
  terminalReceived: boolean;
  settled: boolean;
}

/** EXPLAIN 副問い合わせを世代単位で管理するコントローラー。 */
export class ExplainQueryLifecycle {
  private generation = 0;
  private current?: ExplainOperation;
  private disposed = false;

  constructor(private readonly dependencies: ExplainLifecycleDependencies) {}

  /** 旧世代を停止して新しい EXPLAIN を開始する。 */
  start(request: CreateQueryRequest, callbacks: ExplainLifecycleCallbacks): void {
    if (this.disposed) return;
    this.cancelCurrent();
    const operation: ExplainOperation = {
      generation: ++this.generation,
      callbacks,
      remoteCancelIssued: false,
      terminalReceived: false,
      settled: false,
    };
    this.current = operation;
    callbacks.setRunning(true);
    callbacks.setText(undefined);

    void this.dependencies
      .createQuery(request)
      .then(({ queryId }) => this.attach(operation, queryId))
      .catch((error: unknown) => {
        this.settle(operation, `-- ${error instanceof Error ? error.message : 'EXPLAIN failed'}`);
      });
  }

  /** 現在世代の購読を閉じ、queryId が確定済みならサーバーへキャンセルを送る。 */
  cancelCurrent(): void {
    const operation = this.current;
    this.generation += 1;
    this.current = undefined;
    if (!operation) return;
    operation.subscription?.close();
    this.cancelRemoteOnce(operation);
  }

  /** アンマウント後の callback を無効化し、現在世代を停止する。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelCurrent();
  }

  private attach(operation: ExplainOperation, queryId: string): void {
    operation.queryId = queryId;
    if (!this.isCurrent(operation)) {
      this.cancelRemoteOnce(operation);
      return;
    }
    operation.subscription = this.dependencies.subscribeQueryEvents(queryId, {
      onEvent: (event) => this.onEvent(operation, event),
      onError: (error) => {
        if (!(error instanceof SseProtocolError) || !this.isCurrent(operation)) return;
        this.cancelRemoteOnce(operation);
        this.settle(operation, `-- ${error.message}`);
      },
    });
  }

  private onEvent(operation: ExplainOperation, event: QueryEvent): void {
    if (!this.isCurrent(operation) || operation.terminalReceived) return;
    if (event.type === 'error') {
      operation.terminalReceived = true;
      this.settle(operation, `-- ${event.error.message}`);
      return;
    }
    if (event.type !== 'done') return;

    operation.terminalReceived = true;
    operation.subscription?.close();
    const queryId = operation.queryId;
    if (!queryId) return;
    void this.dependencies
      .fetchQueryRows(queryId, 0, 10_000)
      .then((page) => {
        const text = page.rows.map((row) => String(row[0] ?? '')).join('\n');
        this.settle(operation, text);
      })
      .catch(() => this.settle(operation));
  }

  private settle(operation: ExplainOperation, text?: string): void {
    if (!this.isCurrent(operation) || operation.settled) return;
    operation.settled = true;
    operation.subscription?.close();
    this.current = undefined;
    if (text !== undefined) operation.callbacks.setText(text);
    operation.callbacks.setRunning(false);
  }

  private cancelRemoteOnce(operation: ExplainOperation): void {
    if (!operation.queryId || operation.remoteCancelIssued) return;
    operation.remoteCancelIssued = true;
    void this.dependencies.cancelQuery(operation.queryId).catch(() => undefined);
  }

  private isCurrent(operation: ExplainOperation): boolean {
    return !this.disposed && this.current === operation && operation.generation === this.generation;
  }
}

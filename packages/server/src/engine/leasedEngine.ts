/**
 * QueryEngine の利用数を追跡し、close 前に実行中 lease の解放を待つ。
 */
import type { EngineEstimateParams, IoExplainExecution, QueryEngine } from './types';

/** reload の外側 timeout より先に drain を打ち切る既定値。 */
export const DEFAULT_ENGINE_DRAIN_TIMEOUT_MS = 55_000;

/** LeasedEngine の drain 設定。 */
export interface LeasedEngineOptions {
  drainTimeoutMs?: number;
  logWarn?: (message: string) => void;
}

/** 参照カウント付き QueryEngine ラッパ。 */
export class LeasedEngine implements QueryEngine {
  private inFlight = 0;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private resolveDrain?: () => void;
  private readonly drainTimeoutMs: number;
  private readonly logWarn: (message: string) => void;

  constructor(
    private readonly inner: QueryEngine,
    options: LeasedEngineOptions = {},
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_ENGINE_DRAIN_TIMEOUT_MS;
    this.logWarn = options.logWarn ?? console.warn;
  }

  get datasourceId(): QueryEngine['datasourceId'] {
    return this.inner.datasourceId;
  }

  get kind(): QueryEngine['kind'] {
    return this.inner.kind;
  }

  get capabilities(): QueryEngine['capabilities'] {
    return this.inner.capabilities;
  }

  lease(): () => void {
    if (this.closing || this.closed) {
      throw new Error(`Engine ${this.datasourceId} is closing`);
    }
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        this.resolveDrain?.();
        this.resolveDrain = undefined;
      }
    };
  }

  executionClient(
    ...args: Parameters<QueryEngine['executionClient']>
  ): ReturnType<QueryEngine['executionClient']> {
    return this.inner.executionClient(...args);
  }

  downloadClient(
    ...args: Parameters<QueryEngine['downloadClient']>
  ): ReturnType<QueryEngine['downloadClient']> {
    return this.inner.downloadClient(...args);
  }

  estimate(...args: Parameters<QueryEngine['estimate']>): ReturnType<QueryEngine['estimate']> {
    return this.inner.estimate(...args);
  }

  validate(...args: Parameters<QueryEngine['validate']>): ReturnType<QueryEngine['validate']> {
    return this.inner.validate(...args);
  }

  ioExplainExecution(params: EngineEstimateParams): IoExplainExecution | undefined {
    return this.inner.ioExplainExecution?.(params);
  }

  listCatalogs(
    ...args: Parameters<QueryEngine['listCatalogs']>
  ): ReturnType<QueryEngine['listCatalogs']> {
    return this.inner.listCatalogs(...args);
  }

  listSchemas(
    ...args: Parameters<QueryEngine['listSchemas']>
  ): ReturnType<QueryEngine['listSchemas']> {
    return this.inner.listSchemas(...args);
  }

  listTables(
    ...args: Parameters<QueryEngine['listTables']>
  ): ReturnType<QueryEngine['listTables']> {
    return this.inner.listTables(...args);
  }

  describeTable(
    ...args: Parameters<QueryEngine['describeTable']>
  ): ReturnType<QueryEngine['describeTable']> {
    return this.inner.describeTable(...args);
  }

  sampleTable(
    ...args: Parameters<QueryEngine['sampleTable']>
  ): ReturnType<QueryEngine['sampleTable']> {
    return this.inner.sampleTable(...args);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.drainAndClose();
    return this.closePromise;
  }

  isClosed(): boolean {
    return this.closing || this.closed || this.inner.isClosed();
  }

  private async drainAndClose(): Promise<void> {
    if (this.inFlight > 0) {
      const drained = await this.waitForDrain();
      if (!drained) {
        this.logWarn(
          `engine ${this.datasourceId} drain timed out with ${this.inFlight} active lease(s)`,
        );
      }
    }
    try {
      await this.inner.close();
    } finally {
      this.closed = true;
    }
  }

  private async waitForDrain(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.resolveDrain = undefined;
        resolve(drained);
      };
      const timer = setTimeout(() => finish(false), this.drainTimeoutMs);
      this.resolveDrain = () => finish(true);
      if (this.inFlight === 0) finish(true);
    });
  }
}

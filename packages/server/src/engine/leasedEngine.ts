/**
 * QueryEngine の利用数を追跡し、close 前に実行中 lease の解放を待つ。
 */
import type {
  EngineEstimateParams,
  IoExplainExecution,
  QueryEngine,
  StatementClient,
} from './types';
import { DEFAULT_STATEMENT_CANCEL_TIMEOUT_MS, runCancelWithTimeout } from './cancelTimeout';

/** reload の外側 timeout より先に drain を打ち切る既定値。 */
export const DEFAULT_ENGINE_DRAIN_TIMEOUT_MS = 55_000;

/** LeasedEngine の drain 設定。 */
export interface LeasedEngineOptions {
  drainTimeoutMs?: number;
  /** statement cancel 1 回の応答待機上限。 */
  cancelTimeoutMs?: number;
  logWarn?: (message: string) => void;
}

/** 参照カウント付き QueryEngine ラッパ。 */
export class LeasedEngine implements QueryEngine {
  private inFlight = 0;
  private explicitInFlight = 0;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private resolveDrain?: () => void;
  private readonly drainTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly logWarn: (message: string) => void;

  constructor(
    private readonly inner: QueryEngine,
    options: LeasedEngineOptions = {},
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_ENGINE_DRAIN_TIMEOUT_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_STATEMENT_CANCEL_TIMEOUT_MS;
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
    this.explicitInFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.explicitInFlight -= 1;
      this.inFlight -= 1;
      this.resolveIfDrained();
    };
  }

  probe(...args: Parameters<QueryEngine['probe']>): ReturnType<QueryEngine['probe']> {
    return this.withLease(() => this.inner.probe(...args));
  }

  executionClient(
    ...args: Parameters<QueryEngine['executionClient']>
  ): ReturnType<QueryEngine['executionClient']> {
    this.assertOpen();
    return this.scopedStatementClient(this.inner.executionClient(...args));
  }

  downloadClient(
    ...args: Parameters<QueryEngine['downloadClient']>
  ): ReturnType<QueryEngine['downloadClient']> {
    this.assertOpen();
    return this.scopedStatementClient(this.inner.downloadClient(...args));
  }

  estimate(...args: Parameters<QueryEngine['estimate']>): ReturnType<QueryEngine['estimate']> {
    return this.withLease(() => this.inner.estimate(...args));
  }

  validate(...args: Parameters<QueryEngine['validate']>): ReturnType<QueryEngine['validate']> {
    return this.withLease(() => this.inner.validate(...args));
  }

  ioExplainExecution(params: EngineEstimateParams): IoExplainExecution | undefined {
    this.assertOpen();
    const execution = this.inner.ioExplainExecution?.(params);
    if (!execution) return undefined;
    return { ...execution, client: this.scopedStatementClient(execution.client) };
  }

  listCatalogs(
    ...args: Parameters<QueryEngine['listCatalogs']>
  ): ReturnType<QueryEngine['listCatalogs']> {
    return this.withLease(() => this.inner.listCatalogs(...args));
  }

  listSchemas(
    ...args: Parameters<QueryEngine['listSchemas']>
  ): ReturnType<QueryEngine['listSchemas']> {
    return this.withLease(() => this.inner.listSchemas(...args));
  }

  listTables(
    ...args: Parameters<QueryEngine['listTables']>
  ): ReturnType<QueryEngine['listTables']> {
    return this.withLease(() => this.inner.listTables(...args));
  }

  describeTable(
    ...args: Parameters<QueryEngine['describeTable']>
  ): ReturnType<QueryEngine['describeTable']> {
    return this.withLease(() => this.inner.describeTable(...args));
  }

  sampleTable(
    ...args: Parameters<QueryEngine['sampleTable']>
  ): ReturnType<QueryEngine['sampleTable']> {
    return this.withLease(() => this.inner.sampleTable(...args));
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

  /** Promise を返す単発操作の完了まで lease を保持する。 */
  private async withLease<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.operationLease();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * 単発操作用 lease を取得する。close 前に受理済みの明示 lease がある処理だけは、
   * drain 中も後続の検証やページ取得を継続できる。
   */
  private operationLease(): () => void {
    if (this.closed || (this.closing && this.explicitInFlight === 0)) {
      throw new Error(`Engine ${this.datasourceId} is closing`);
    }
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.resolveIfDrained();
    };
  }

  /** 全 lease が解放された時点で drain 待機を完了する。 */
  private resolveIfDrained(): void {
    if (this.inFlight !== 0) return;
    this.resolveDrain?.();
    this.resolveDrain = undefined;
  }

  /** close 開始後にクライアントを新規作成しない。 */
  private assertOpen(): void {
    if (this.closed || (this.closing && this.explicitInFlight === 0)) {
      throw new Error(`Engine ${this.datasourceId} is closing`);
    }
  }

  /**
   * ステートメントの開始から終端ページまたはキャンセルまで lease を保持する。
   * advance 失敗時は driver の後始末が cancel するまで保持する。
   * 最初の実操作まで lease を遅延し、開始前にキャンセルされたクライアントによる
   * drain 停滞を防ぐ。
   */
  private scopedStatementClient(inner: StatementClient): StatementClient {
    let release: (() => void) | undefined;
    let terminal = false;

    const ensureLease = (): void => {
      if (terminal) throw new Error(`Engine ${this.datasourceId} statement client is settled`);
      release ??= this.operationLease();
    };
    const releaseActiveLease = (): void => {
      release?.();
      release = undefined;
    };
    const complete = (): void => {
      if (terminal) return;
      terminal = true;
      releaseActiveLease();
    };
    const runPage = async <T extends { nextUri?: string }>(
      operation: () => Promise<T>,
      releaseOnFailure: boolean,
    ) => {
      ensureLease();
      try {
        const page = await operation();
        if (!page.nextUri) complete();
        return page;
      } catch (err) {
        // start 失敗時は cancel URI がない。advance 失敗時は driver の finally が
        // 現在 URI を cancel できるよう、lease と非終端状態を残す。
        if (releaseOnFailure) complete();
        throw err;
      }
    };

    return {
      start: (...args) => runPage(() => inner.start(...args), true),
      advance: (...args) => runPage(() => inner.advance(...args), false),
      cancel: async (...args) => {
        ensureLease();
        try {
          await runCancelWithTimeout(() => inner.cancel(...args), this.cancelTimeoutMs);
          complete();
        } catch (error) {
          // 失敗した試行の lease だけを解放し、同じ client からの再試行を許可する。
          releaseActiveLease();
          throw error;
        }
      },
      waitBackoff: async (...args) => {
        if (terminal) throw new Error(`Engine ${this.datasourceId} statement client is settled`);
        if (release) return inner.waitBackoff(...args);
        const releaseWait = this.operationLease();
        try {
          await inner.waitBackoff(...args);
        } finally {
          releaseWait();
        }
      },
    };
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

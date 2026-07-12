/**
 * ステートメントのページ追走と所有権を一元管理する。
 */
import { createSqlAbortError, raceSqlAbort } from './sql/abort';
import { DEFAULT_STATEMENT_CANCEL_TIMEOUT_MS, runCancelWithTimeout } from './cancelTimeout';
import type { StatementClient } from './types';
import {
  emptySessionMutations,
  type TrinoRequestContext,
  type TrinoSessionMutations,
  type TrinoStatementResponse,
} from '../trino/types';

/** ページ observer が追走を続けるか、現在ページで打ち切るかを表す。 */
export type StatementPageDecision = 'continue' | 'stop';

/** ページ observer に渡す追走位置。 */
export interface StatementPageVisit {
  page: TrinoStatementResponse;
  index: number;
  first: boolean;
}

/** 共通ページ driver の入力。 */
export interface StatementPageDriverOptions {
  client: StatementClient;
  statement: string;
  ctx: TrinoRequestContext;
  mutations?: TrinoSessionMutations;
  signal?: AbortSignal;
  /** 指定時間を超えた追走を中断する。未指定の場合は外部 signal だけを使う。 */
  timeoutMs?: number;
  /** 外部キャンセルと driver の後始末で共有するカーソル。 */
  cursor?: StatementPageCursor;
  /** cancel 1 回の応答待機上限。 */
  cancelTimeoutMs?: number;
}

/** observer 方式で追走した結果。 */
export interface StatementPageDriverResult {
  completed: boolean;
  lastPage: TrinoStatementResponse;
}

/**
 * 現在の nextUri とキャンセル状態を保持する。
 * 同じ URI への同時キャンセルは一つの Promise にまとめる。
 */
export class StatementPageCursor {
  /** DELETE cancel に使う最新の nextUri。 */
  private nextUri?: string;
  private cancellation?: { uri: string; promise: Promise<void> };

  constructor(
    private readonly client: StatementClient,
    private readonly ctx: TrinoRequestContext,
    private readonly cancelTimeoutMs = DEFAULT_STATEMENT_CANCEL_TIMEOUT_MS,
  ) {}

  /** 現在サーバー側で所有している nextUri。 */
  get currentNextUri(): string | undefined {
    return this.nextUri;
  }

  /** 応答受信後に所有権を次の URI へ移す。 */
  update(nextUri: string | undefined): void {
    this.nextUri = nextUri;
  }

  /** 正常完走したためキャンセル対象がないことを記録する。 */
  complete(): void {
    this.nextUri = undefined;
  }

  /** 現在の URI をキャンセルし、同時試行だけを一つの Promise にまとめる。 */
  async cancel(): Promise<void> {
    const uri = this.nextUri;
    if (uri === undefined) return;
    if (this.cancellation?.uri === uri) {
      await this.cancellation.promise;
      return;
    }
    const promise = runCancelWithTimeout(
      () => this.client.cancel(uri, this.ctx),
      this.cancelTimeoutMs,
    );
    this.cancellation = { uri, promise };
    try {
      await promise;
      if (this.nextUri === uri) this.nextUri = undefined;
    } finally {
      if (this.cancellation?.promise === promise) this.cancellation = undefined;
    }
  }

  /** driver 終了時にキャンセル失敗で元の結果を上書きしない。 */
  async cancelBestEffort(): Promise<void> {
    await this.cancel().catch(() => undefined);
  }
}

/**
 * start から終端ページまでを async iterable として返す。
 * consumer のページ処理が完了するまで次ページを取得しない。
 */
export async function* statementPages(
  options: StatementPageDriverOptions,
): AsyncGenerator<TrinoStatementResponse> {
  const mutations = options.mutations ?? emptySessionMutations();
  const timeout = createTimeoutSignal(options.signal, options.timeoutMs);
  const signal = timeout.signal;
  const cursor =
    options.cursor ??
    new StatementPageCursor(
      options.client,
      options.ctx,
      options.cancelTimeoutMs ?? DEFAULT_STATEMENT_CANCEL_TIMEOUT_MS,
    );

  try {
    throwIfAborted(signal);
    let page = await options.client.start(options.statement, options.ctx, mutations, signal);
    cursor.update(page.nextUri);
    throwIfAborted(signal);
    yield page;
    throwIfAborted(signal);

    let idleAttempt = 0;
    while (page.nextUri) {
      // 行が流れている間は待たず、空ページが続く場合だけ backoff を段階的に増やし、
      // ストリーミング結果をページごとの待機で減速させない。
      if (page.data && page.data.length > 0) {
        idleAttempt = 0;
      } else {
        await options.client.waitBackoff(idleAttempt, signal);
        throwIfAborted(signal);
        idleAttempt += 1;
      }

      page = await options.client.advance(page.nextUri, options.ctx, mutations, signal);
      cursor.update(page.nextUri);
      throwIfAborted(signal);
      yield page;
      throwIfAborted(signal);
    }
    // nextUri がない終端ページまで到達したため、cancel 対象を破棄する。
    cursor.complete();
  } finally {
    // 正常完走前に consumer、observer、通信、Abort のいずれで終了しても、
    // driver が最後に所有していた nextUri をベストエフォートで解放する。
    timeout.clear();
    await cursor.cancelBestEffort();
  }
}

/** 全ページを observer へ順番に渡し、打ち切り時も driver の後始末を待つ。 */
export async function driveStatementPages(
  options: StatementPageDriverOptions & {
    onPage: (
      visit: StatementPageVisit,
    ) => StatementPageDecision | void | Promise<StatementPageDecision | void>;
  },
): Promise<StatementPageDriverResult> {
  const timeout = createTimeoutSignal(options.signal, options.timeoutMs);
  try {
    let index = 0;
    let lastPage: TrinoStatementResponse | undefined;
    for await (const page of statementPages({
      ...options,
      signal: timeout.signal,
      timeoutMs: undefined,
    })) {
      lastPage = page;
      const observed = Promise.resolve(options.onPage({ page, index, first: index === 0 }));
      const decision = await raceSqlAbort(observed, timeout.signal);
      index += 1;
      if (decision === 'stop') return { completed: false, lastPage: page };
    }
    if (!lastPage) throw new Error('Statement driver completed without an initial page');
    return { completed: true, lastPage };
  } finally {
    timeout.clear();
  }
}

function createTimeoutSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; clear: () => void } {
  if (timeoutMs === undefined) return { signal: external, clear: () => undefined };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Statement timeoutMs must be a positive finite number');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: external ? AbortSignal.any([external, controller.signal]) : controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createSqlAbortError();
}

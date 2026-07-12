/** 外部 engine への best-effort cancel を有限時間で打ち切る。 */

/** cancel 1 回の応答を待つ既定上限。 */
export const DEFAULT_STATEMENT_CANCEL_TIMEOUT_MS = 5_000;

/** cancel が期限内に完了しなかったことを表す。 */
export class StatementCancelTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Statement cancel timed out after ${timeoutMs}ms`);
    this.name = 'StatementCancelTimeoutError';
  }
}

/**
 * cancel Promise に即時 rejection handler を付け、期限後に遅れて失敗しても
 * 未処理 rejection にしない。
 */
export async function runCancelWithTimeout(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Statement cancel timeout must be a positive finite number');
  }

  const attempt = Promise.resolve().then(operation);
  void attempt.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (succeeded: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (succeeded) resolve();
      else reject(error);
    };
    const timer = setTimeout(
      () => finish(false, new StatementCancelTimeoutError(timeoutMs)),
      timeoutMs,
    );
    timer.unref?.();
    void attempt.then(
      () => finish(true),
      (error: unknown) => finish(false, error),
    );
  });
}

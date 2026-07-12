/**
 * SQL ドライバの Promise と AbortSignal を競合させる補助関数。
 */

/** AbortSignal による中断を表すエラーを生成する。 */
export function createSqlAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Promise の完了前に signal が中断された場合、後始末を実行して直ちに reject する。
 * 元の Promise は拒否後も監視し、遅れて失敗しても未処理 rejection にしない。
 */
export function raceSqlAbort<T>(
  promise: PromiseLike<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return Promise.resolve(promise);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => {
      finish(() => {
        try {
          onAbort?.();
        } catch {
          // 中断通知は後始末の失敗より優先する。
        }
        reject(createSqlAbortError());
      });
    };

    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
}

/**
 * 中断不能な pool acquisition を待つ間だけ呼び出し元を中断可能にする。
 * 中断後に接続が遅れて払い出された場合は、利用せず破棄する。
 */
export async function acquireSqlResource<T>(
  acquisition: PromiseLike<T>,
  signal: AbortSignal | undefined,
  destroy: (resource: T) => void,
): Promise<T> {
  const pending = Promise.resolve(acquisition);
  let claimed = false;
  const destroyLateResource = (): void => {
    void pending.then(
      (resource) => {
        if (!claimed) {
          try {
            destroy(resource);
          } catch {
            // 呼び出し元はすでに中断済みのため、遅延破棄の失敗は伝播させない。
          }
        }
      },
      () => undefined,
    );
  };

  const resource = await raceSqlAbort(pending, signal, destroyLateResource);
  claimed = true;
  if (signal?.aborted) {
    destroy(resource);
    throw createSqlAbortError();
  }
  return resource;
}

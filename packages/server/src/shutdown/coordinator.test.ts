/** ShutdownCoordinator の実行順序、失敗隔離、期限、冪等性を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import {
  ShutdownCoordinator,
  ShutdownTimeoutError,
  type ShutdownTimerFactory,
} from './coordinator';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ShutdownCoordinator', () => {
  it('受付停止、drain、HTTP close、資源解放を順番に実行する', async () => {
    const calls: string[] = [];
    const httpClose = deferred();
    const drain = deferred();
    const coordinator = new ShutdownCoordinator({
      timeoutMs: 1_000,
      beginHttpClose: () => {
        calls.push('begin-http-close');
        return httpClose.promise.then(() => {
          calls.push('http-closed');
        });
      },
      stopAdmission: () => {
        calls.push('stop-admission');
      },
      drain: () => {
        calls.push('drain');
        return drain.promise.then(() => {
          calls.push('drained');
        });
      },
      forceCloseHttp: vi.fn(),
      closeResources: () => {
        calls.push('close-resources');
      },
    });

    const resultPromise = coordinator.shutdown();
    expect(calls).toEqual(['begin-http-close', 'stop-admission', 'drain']);
    httpClose.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['begin-http-close', 'stop-admission', 'drain', 'http-closed']);
    drain.resolve();

    await expect(resultPromise).resolves.toEqual({ timedOut: false, errors: [] });
    expect(calls).toEqual([
      'begin-http-close',
      'stop-admission',
      'drain',
      'http-closed',
      'drained',
      'close-resources',
    ]);
  });

  it('重複呼び出しへ同じ Promise を返し、各処理を一度だけ実行する', async () => {
    const httpClose = deferred();
    const beginHttpClose = vi.fn(() => httpClose.promise);
    const stopAdmission = vi.fn();
    const drain = vi.fn(async () => undefined);
    const closeResources = vi.fn();
    const coordinator = new ShutdownCoordinator({
      timeoutMs: 1_000,
      beginHttpClose,
      stopAdmission,
      drain,
      forceCloseHttp: vi.fn(),
      closeResources,
    });

    const first = coordinator.shutdown();
    const second = coordinator.shutdown();
    expect(first).toBe(second);
    httpClose.resolve();
    await first;

    expect(beginHttpClose).toHaveBeenCalledOnce();
    expect(stopAdmission).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
  });

  it('一つの段階が失敗しても後続段階と資源解放を実行する', async () => {
    const beginError = new Error('HTTP close failed');
    const admissionError = new Error('admission stop failed');
    const drainError = new Error('drain failed');
    const closeError = new Error('resource close failed');
    const calls: string[] = [];
    const coordinator = new ShutdownCoordinator({
      timeoutMs: 1_000,
      beginHttpClose: () => {
        calls.push('begin-http-close');
        throw beginError;
      },
      stopAdmission: () => {
        calls.push('stop-admission');
        throw admissionError;
      },
      drain: async () => {
        calls.push('drain');
        throw drainError;
      },
      forceCloseHttp: vi.fn(),
      closeResources: () => {
        calls.push('close-resources');
        throw closeError;
      },
    });

    const result = await coordinator.shutdown();

    expect(calls).toEqual(['begin-http-close', 'stop-admission', 'drain', 'close-resources']);
    expect(result.timedOut).toBe(false);
    expect(result.errors).toEqual([
      { phase: 'begin-http-close', error: beginError },
      { phase: 'stop-admission', error: admissionError },
      { phase: 'drain', error: drainError },
      { phase: 'close-resources', error: closeError },
    ]);
  });

  it('drain が失敗しても HTTP close の完了を待ってから資源を解放する', async () => {
    const drainError = new Error('drain failed');
    const httpClose = deferred();
    const calls: string[] = [];
    const coordinator = new ShutdownCoordinator({
      timeoutMs: 1_000,
      beginHttpClose: () => {
        calls.push('begin-http-close');
        return httpClose.promise.then(() => {
          calls.push('http-closed');
        });
      },
      stopAdmission: () => {
        calls.push('stop-admission');
      },
      drain: async () => {
        calls.push('drain');
        throw drainError;
      },
      forceCloseHttp: vi.fn(),
      closeResources: () => {
        calls.push('close-resources');
      },
    });

    const resultPromise = coordinator.shutdown();
    await Promise.resolve();
    expect(calls).toEqual(['begin-http-close', 'stop-admission', 'drain']);
    httpClose.resolve();
    const result = await resultPromise;

    expect(calls).toEqual([
      'begin-http-close',
      'stop-admission',
      'drain',
      'http-closed',
      'close-resources',
    ]);
    expect(result).toEqual({ timedOut: false, errors: [{ phase: 'drain', error: drainError }] });
  });

  it('絶対期限を超えると HTTP を一度だけ強制 close して資源を解放する', async () => {
    const drain = deferred();
    const httpClose = deferred();
    const forceCloseHttp = vi.fn();
    const closeResources = vi.fn();
    const aborted = vi.fn();
    let now = 1_000;
    let timerCallback: (() => void) | undefined;
    const setTimer: ShutdownTimerFactory = (callback) => {
      timerCallback = callback;
      return { clear: vi.fn() };
    };
    const coordinator = new ShutdownCoordinator({
      timeoutMs: 500,
      now: () => now,
      setTimer,
      beginHttpClose: () => httpClose.promise,
      stopAdmission: vi.fn(),
      drain: ({ deadlineAt, signal }) => {
        expect(deadlineAt).toBe(1_500);
        expect(signal.aborted).toBe(false);
        signal.addEventListener('abort', aborted);
        return drain.promise;
      },
      forceCloseHttp,
      closeResources,
    });

    const resultPromise = coordinator.shutdown();
    now = 1_500;
    timerCallback?.();
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map(({ phase }) => phase)).toEqual(['drain', 'http-close']);
    expect(result.errors[0]?.error).toBeInstanceOf(ShutdownTimeoutError);
    expect(result.errors[1]?.error).toBeInstanceOf(ShutdownTimeoutError);
    expect(aborted).toHaveBeenCalledOnce();
    expect(forceCloseHttp).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
  });

  it('drain の期限超過前に完了した HTTP close を timeout と誤記録しない', async () => {
    const drain = deferred();
    const httpClose = deferred();
    let now = 1_000;
    let timerCallback: (() => void) | undefined;
    const coordinator = new ShutdownCoordinator({
      timeoutMs: 500,
      now: () => now,
      setTimer: (callback) => {
        timerCallback = callback;
        return { clear: vi.fn() };
      },
      beginHttpClose: () => httpClose.promise,
      stopAdmission: vi.fn(),
      drain: () => drain.promise,
      forceCloseHttp: vi.fn(),
      closeResources: vi.fn(),
    });

    const resultPromise = coordinator.shutdown();
    httpClose.resolve();
    await Promise.resolve();
    now = 1_500;
    timerCallback?.();
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.errors.map(({ phase }) => phase)).toEqual(['drain']);
  });

  it('資源解放が絶対期限を超えても強制 close 後に結果を返す', async () => {
    const closeResourcesGate = deferred();
    const forceCloseHttp = vi.fn();
    const closeResources = vi.fn(() => closeResourcesGate.promise);
    let now = 1_000;
    let timerCallback: (() => void) | undefined;
    const coordinator = new ShutdownCoordinator({
      timeoutMs: 500,
      now: () => now,
      setTimer: (callback) => {
        timerCallback = callback;
        return { clear: vi.fn() };
      },
      beginHttpClose: async () => undefined,
      stopAdmission: vi.fn(),
      drain: async () => undefined,
      forceCloseHttp,
      closeResources,
    });

    const resultPromise = coordinator.shutdown();
    await vi.waitFor(() => expect(closeResources).toHaveBeenCalledOnce());
    now = 1_500;
    timerCallback?.();
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.phase).toBe('close-resources');
    expect(result.errors[0]?.error).toBeInstanceOf(ShutdownTimeoutError);
    expect(forceCloseHttp).toHaveBeenCalledOnce();
  });
});

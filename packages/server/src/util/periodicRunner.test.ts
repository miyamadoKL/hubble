/** PeriodicRunner の例外隔離、再予約、重複抑止、停止待機を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import { PeriodicRunner, type PeriodicTimerHandle } from './periodicRunner';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PeriodicRunner', () => {
  it('logs a rejected tick and schedules the next tick', async () => {
    const callbacks: Array<() => void> = [];
    const setTimer = (callback: () => void): PeriodicTimerHandle => {
      callbacks.push(callback);
      return { clear: vi.fn() };
    };
    const failure = new Error('repository unavailable');
    const logError = vi.fn();
    const runner = new PeriodicRunner({
      intervalMs: 1_000,
      task: () => Promise.reject(failure),
      logError,
      errorMessage: 'tick failed',
      setTimer,
    });

    runner.start();
    callbacks[0]!();
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith('tick failed', failure));
    expect(callbacks).toHaveLength(2);
    await runner.stop();
  });

  it('shares one in-flight task and waits for it during stop', async () => {
    const gate = deferred();
    const task = vi.fn(() => gate.promise);
    const runner = new PeriodicRunner({
      intervalMs: 1_000,
      task,
      logError: vi.fn(),
      errorMessage: 'tick failed',
      setTimer: () => ({ clear: vi.fn() }),
    });

    const first = runner.runNow();
    const second = runner.runNow();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(task).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
  });
});

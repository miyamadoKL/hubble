import { describe, expect, test, vi } from 'vitest';
import type { QueryEvent } from '@hubble/contracts';
import { SseProtocolError, subscribeQueryEvents, type EventSourceLike } from './sse';

/**
 * Mock EventSource that records listeners and lets a test push frames. Mirrors
 * the server's named-event protocol: each `type` is emitted as a named SSE
 * event whose `data` is the JSON event body.
 */
class MockEventSource implements EventSourceLike {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: ((this: unknown, ev: Event) => unknown) | null = null;
  private listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  /** Emit a contract event as its named SSE frame. */
  emit(event: QueryEvent): void {
    const list = this.listeners.get(event.type) ?? [];
    const message = { data: JSON.stringify(event) } as MessageEvent;
    for (const l of list) l(message);
    if (event.type === 'error') this.onerror?.call(this, message);
  }

  /** Emit a raw (possibly malformed) frame on a given event name. */
  emitRaw(type: string, data: string): void {
    const list = this.listeners.get(type) ?? [];
    for (const l of list) l({ data } as MessageEvent);
  }

  fireError(): void {
    const event = new Event('error');
    for (const listener of this.listeners.get('error') ?? []) listener(event);
    this.onerror?.call(this, event);
  }
}

function factory(url: string): EventSourceLike {
  return new MockEventSource(url);
}

describe('subscribeQueryEvents', () => {
  test('replay → live → done: parses frames and closes on done', () => {
    MockEventSource.instances = [];
    const events: QueryEvent[] = [];
    const sub = subscribeQueryEvents('q1', { onEvent: (e) => events.push(e) }, factory);
    const src = MockEventSource.instances[0]!;

    // Server replay sequence.
    src.emit({ type: 'state', state: 'running' });
    src.emit({ type: 'columns', columns: [{ name: 'a', type: 'bigint' }] });
    src.emit({ type: 'rows', offset: 0, rows: [[1], [2]] });
    src.emit({ type: 'stats', stats: makeStats('RUNNING') });
    // Live + terminal.
    src.emit({ type: 'rows', offset: 2, rows: [[3]] });
    src.emit({ type: 'done', state: 'finished', rowCount: 3, truncated: false });

    expect(events.map((e) => e.type)).toEqual([
      'state',
      'columns',
      'rows',
      'stats',
      'rows',
      'done',
    ]);
    // The subscription auto-closes after `done`.
    expect(src.closed).toBe(true);
    sub.close(); // idempotent
  });

  test('forwards an error event then a done', () => {
    MockEventSource.instances = [];
    const events: QueryEvent[] = [];
    const onError = vi.fn();
    subscribeQueryEvents('q2', { onEvent: (e) => events.push(e), onError }, factory);
    const src = MockEventSource.instances[0]!;

    src.emit({ type: 'state', state: 'running' });
    src.emit({
      type: 'error',
      error: { code: 'TRINO_ERROR', message: 'boom', trinoErrorName: 'SYNTAX_ERROR' },
    });
    src.emit({ type: 'done', state: 'failed', rowCount: 0, truncated: false });

    expect(events.map((e) => e.type)).toEqual(['state', 'error', 'done']);
    expect(onError).not.toHaveBeenCalled();
    expect(src.closed).toBe(true);
  });

  test.each([
    ['不正なJSON', 'not json'],
    ['schema不一致', JSON.stringify({ type: 'state' })],
    ['イベント名不一致', JSON.stringify({ type: 'done', state: 'finished', rowCount: 0 })],
  ])('%sをログして捨て、次の正常frameを処理する', (_label, data) => {
    MockEventSource.instances = [];
    const events: QueryEvent[] = [];
    const onError = vi.fn();
    subscribeQueryEvents('q3', { onEvent: (e) => events.push(e), onError }, factory);
    const src = MockEventSource.instances[0]!;

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    src.emitRaw('state', data);
    src.emit({ type: 'state', state: 'queued' });

    expect(events).toEqual([{ type: 'state', state: 'queued' }]);
    expect(src.closed).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  test('連続3件の不正frameをprotocol errorとして閉じる', () => {
    MockEventSource.instances = [];
    const onError = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeQueryEvents('q3', { onEvent: () => {}, onError }, factory);
    const src = MockEventSource.instances[0]!;

    src.emitRaw('state', 'broken-1');
    src.emitRaw('state', 'broken-2');
    src.emitRaw('state', 'broken-3');

    expect(src.closed).toBe(true);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(SseProtocolError);
    log.mockRestore();
  });

  test('正常なrowsが制御frameのストライクをリセットする', () => {
    MockEventSource.instances = [];
    const onError = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeQueryEvents('q3', { onEvent: () => {}, onError }, factory);
    const src = MockEventSource.instances[0]!;

    src.emitRaw('state', 'broken-1');
    src.emitRaw('state', 'broken-2');
    src.emit({ type: 'rows', offset: 0, rows: [[1]] });
    src.emitRaw('state', 'broken-3');

    expect(src.closed).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    log.mockRestore();
  });

  test('不正なrowsは有界ログで捨ててdoneを処理する', () => {
    MockEventSource.instances = [];
    const events: QueryEvent[] = [];
    const onError = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeQueryEvents('q3', { onEvent: (event) => events.push(event), onError }, factory);
    const src = MockEventSource.instances[0]!;

    src.emitRaw('rows', 'broken-1');
    src.emitRaw('rows', 'broken-2');
    src.emitRaw('rows', 'broken-3');
    src.emit({ type: 'done', state: 'finished', rowCount: 3, truncated: false });

    expect(events).toEqual([{ type: 'done', state: 'finished', rowCount: 3, truncated: false }]);
    expect(src.closed).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  test('forwards transport errors and stays open until closed', () => {
    MockEventSource.instances = [];
    const onError = vi.fn();
    const sub = subscribeQueryEvents('q4', { onEvent: () => {}, onError }, factory);
    const src = MockEventSource.instances[0]!;

    src.fireError();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(src.closed).toBe(false);

    sub.close();
    expect(src.closed).toBe(true);
    // After close, further error callbacks are suppressed.
    src.fireError();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

function makeStats(state: string) {
  return {
    state,
    queuedSplits: 0,
    runningSplits: 1,
    completedSplits: 0,
    totalSplits: 4,
    processedRows: 2,
    processedBytes: 64,
    wallTimeMillis: 10,
    elapsedTimeMillis: 12,
    peakMemoryBytes: 128,
  };
}

export { MockEventSource };

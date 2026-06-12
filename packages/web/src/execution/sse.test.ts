import { describe, expect, test, vi } from 'vitest';
import type { QueryEvent } from '@hue-fable/contracts';
import { subscribeQueryEvents, type EventSourceLike } from './sse';

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
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
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
  }

  /** Emit a raw (possibly malformed) frame on a given event name. */
  emitRaw(type: string, data: string): void {
    const list = this.listeners.get(type) ?? [];
    for (const l of list) l({ data } as MessageEvent);
  }

  fireError(): void {
    this.onerror?.call(this, new Event('error'));
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
    subscribeQueryEvents('q2', { onEvent: (e) => events.push(e) }, factory);
    const src = MockEventSource.instances[0]!;

    src.emit({ type: 'state', state: 'running' });
    src.emit({
      type: 'error',
      error: { code: 'TRINO_ERROR', message: 'boom', trinoErrorName: 'SYNTAX_ERROR' },
    });
    src.emit({ type: 'done', state: 'failed', rowCount: 0, truncated: false });

    expect(events.map((e) => e.type)).toEqual(['state', 'error', 'done']);
    expect(src.closed).toBe(true);
  });

  test('ignores malformed / non-conforming frames', () => {
    MockEventSource.instances = [];
    const events: QueryEvent[] = [];
    subscribeQueryEvents('q3', { onEvent: (e) => events.push(e) }, factory);
    const src = MockEventSource.instances[0]!;

    src.emitRaw('state', 'not json');
    src.emitRaw('state', JSON.stringify({ type: 'state' })); // missing `state`
    src.emit({ type: 'state', state: 'queued' });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'state', state: 'queued' });
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

// Thin, testable SSE subscription over `GET /api/queries/:id/events`
// (design.md §3, §7). The server replays current state on connect
// (state → columns → rows chunks → stats → [error] → done) and then streams
// live; `done` ends the stream. We parse every frame with the contracts
// `queryEventSchema` and hand typed events to the store. Reconnecting with the
// same queryId is safe and replays from scratch.
//
// The native EventSource is injected (defaults to the global) so vitest can
// drive a mock implementation deterministically — no real network, no jsdom
// EventSource gaps.

import { queryEventSchema, queryEventNames, type QueryEvent } from '@hubble/contracts';
import { apiRoutes } from '../api/client';

/** Minimal EventSource surface we depend on (a subset of the DOM type). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onerror: ((this: unknown, ev: Event) => unknown) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface SseHandlers {
  onEvent: (event: QueryEvent) => void;
  /** Transport-level error (connection dropped before `done`). */
  onError?: (error: Event) => void;
}

export interface SseSubscription {
  /** Close the underlying EventSource. Idempotent. */
  close: () => void;
}

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

/**
 * Subscribe to a query's event stream. Each named SSE event (`state`,
 * `columns`, `rows`, `stats`, `error`, `done`) is parsed against the contract
 * union and forwarded. On `done` the source is closed automatically. Returns a
 * handle whose `close()` tears the connection down (also idempotent).
 */
export function subscribeQueryEvents(
  queryId: string,
  handlers: SseHandlers,
  factory: EventSourceFactory = defaultFactory,
): SseSubscription {
  const source = factory(apiRoutes.queryEvents(queryId));
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  const handle = (raw: MessageEvent) => {
    if (closed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw.data as string);
    } catch {
      return; // ignore malformed frames
    }
    const parsed = queryEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const event = parsed.data;
    handlers.onEvent(event);
    if (event.type === 'done') close();
  };

  for (const name of queryEventNames) {
    source.addEventListener(name, handle);
  }

  source.onerror = (event: Event) => {
    if (closed) return;
    handlers.onError?.(event);
  };

  return { close };
}

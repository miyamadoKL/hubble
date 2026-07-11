// Thin, testable SSE subscription over `GET /api/queries/:id/events`.
// The server replays current state on connect
// (state → columns → rows chunks → stats → [error] → done) and then streams
// live; `done` ends the stream. We parse every frame with the contracts
// `queryEventSchema` and hand typed events to the store. Reconnecting with the
// same queryId is safe and replays from scratch.
//
// The native EventSource is injected (defaults to the global) so vitest can
// drive a mock implementation deterministically — no real network, no jsdom
// EventSource gaps.
//
// ==== ファイルの責務（日本語） ================================================
// `GET /api/queries/:id/events` に対する、薄くテスト可能な SSE（Server-Sent
// Events）購読レイヤー。サーバーは接続時に現在状態をリプレイし
// （state → columns → rows チャンク → stats → [error] → done の順）、その後は
// ライブでイベントを流し続ける。`done` でストリームは終了する。すべての
// フレームは contracts の `queryEventSchema` で検証してから、型付きイベントとして
// ストアへ渡す。同じ queryId で再接続しても安全（サーバー側がゼロからリプレイ
// する）。
// ネイティブの EventSource はファクトリとして注入可能にしてある（デフォルトは
// グローバルの EventSource）。これにより vitest では実ネットワークや jsdom の
// EventSource 実装差異に頼らず、モック実装を決定的に駆動してテストできる。
// ============================================================================

import { queryEventSchema, queryEventNames, type QueryEvent } from '@hubble/contracts';
import { apiRoutes } from '../api/client';

/** Minimal EventSource surface we depend on (a subset of the DOM type). */
/** このモジュールが依存する EventSource の最小限のインターフェース（DOM 型の部分集合）。 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void;
  close(): void;
  onerror: ((this: unknown, ev: Event) => unknown) | null;
}

/** URL から EventSourceLike を生成するファクトリ関数の型（テストではモックに差し替える）。 */
export type EventSourceFactory = (url: string) => EventSourceLike;

/** SSE 購読者が指定するハンドラ群。 */
export interface SseHandlers {
  onEvent: (event: QueryEvent) => void;
  /** Transport-level error (connection dropped before `done`). */
  /** 通信レベルのエラー（`done` を受け取る前に接続が切れた場合）。 */
  onError?: (error: Event | SseProtocolError) => void;
}

/** 契約済みSSEイベントのフレームが壊れていたことを表すエラー。 */
export class SseProtocolError extends Error {
  constructor(readonly eventName: string) {
    super(`Invalid SSE frame for event: ${eventName}`);
    this.name = 'SseProtocolError';
  }
}

/** 購読ハンドル。呼び出し側は `close()` で明示的に接続を終了できる。 */
export interface SseSubscription {
  /** Close the underlying EventSource. Idempotent. */
  /** 内部の EventSource を閉じる。複数回呼んでも安全（冪等）。 */
  close: () => void;
}

// デフォルトのファクトリ: ブラウザ組み込みの EventSource をそのまま使う。
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
  // EventSource（またはそのモック）を生成して接続を開始する。
  const source = factory(apiRoutes.queryEvents(queryId));
  let closed = false;
  let consecutiveControlProtocolErrors = 0;
  let invalidRowsLogged = false;
  let forwardedTransportError: Event | undefined;

  // 接続を閉じる。二重に呼ばれても副作用が起きないよう closed フラグで防御する。
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  // 1 フレーム分のイベントを処理する共通ハンドラ。すべての名前付きイベント
  // （state/columns/rows/stats/error/done）がここに集約される。
  const handle = (eventName: string, raw: Event | MessageEvent) => {
    if (closed) return; // 既に閉じている購読からの遅延イベントは無視する。
    if (!('data' in raw) || typeof raw.data !== 'string') {
      forwardedTransportError = raw;
      handlers.onError?.(raw);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.data);
    } catch {
      handleProtocolError(eventName);
      return;
    }
    // contracts のスキーマで検証し、型付きの QueryEvent に絞り込む。
    const parsed = queryEventSchema.safeParse(payload);
    if (!parsed.success || parsed.data.type !== eventName) {
      handleProtocolError(eventName);
      return;
    }
    const event = parsed.data;
    consecutiveControlProtocolErrors = 0;
    handlers.onEvent(event);
    // done イベントでストリームは完結するので、自動的に接続を閉じる。
    if (event.type === 'done') close();
  };

  /** 単発の制御frame違反は捨て、連続違反だけを購読の異常終端へ昇格する。 */
  const handleProtocolError = (eventName: string): void => {
    if (eventName === 'rows') {
      if (!invalidRowsLogged) {
        console.error(`Invalid SSE frame for event: ${eventName}`);
        invalidRowsLogged = true;
      }
      return;
    }
    consecutiveControlProtocolErrors += 1;
    console.error(`Invalid SSE frame for event: ${eventName}`);
    if (consecutiveControlProtocolErrors < 3) return;
    close();
    handlers.onError?.(new SseProtocolError(eventName));
  };

  // サーバーが送る名前付きイベントすべてに同じハンドラを登録する。
  for (const name of queryEventNames) {
    source.addEventListener(name, (event) => handle(name, event));
  }

  // 通信自体が切れた場合（done を受け取る前の切断など）のハンドラ。
  source.onerror = (event: Event) => {
    if (closed) return;
    if ('data' in event && typeof event.data === 'string') return;
    if (event === forwardedTransportError) {
      forwardedTransportError = undefined;
      return;
    }
    handlers.onError?.(event);
  };

  return { close };
}

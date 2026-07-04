// Pure reducer for the History panel's offset paging (offset
// ページング 50 件, もっと見る). Pages are appended as they arrive; switching the
// state filter resets the accumulator. Kept framework-free so it can be unit
// tested directly (履歴ページング reducer のテスト).
//
// このファイルは HistoryPanel が使う「offset ページング」の状態管理ロジックを
// React から切り離して純粋関数として提供するモジュールである。React の
// useInfiniteQuery が内部で行っているページ結合、重複排除、次オフセット計算と
// 同等のロジックを、フレームワーク非依存の reducer / ヘルパー関数として実装しており、
// 単体テスト（historyPaging.test.ts）で直接検証できるようにしている。

import type { QueryHistoryEntry, QueryState } from '@hubble/contracts';

// 履歴パネルの state フィルタの型。'all' は全件、それ以外は QueryState の値（finished 等）と一致させる。
export type HistoryFilter = 'all' | QueryState;

/** 履歴ページングの現在状態を表す型。 */
export interface HistoryPagingState {
  /** The active state filter (drives the request's `state=` param). */
  filter: HistoryFilter;
  /** Accumulated entries across the loaded pages, in server order. */
  items: QueryHistoryEntry[];
  /** Next offset to request. */
  offset: number;
  /** Total matching rows reported by the server (for "has more"). */
  total: number;
}

// reducer が受け付けるアクション。'reset' はフィルタ変更時の初期化、
// 'pageLoaded' は API から 1 ページ分のレスポンスが届いたときに dispatch する。
export type HistoryPagingAction =
  | { type: 'reset'; filter: HistoryFilter }
  | { type: 'pageLoaded'; offset: number; items: QueryHistoryEntry[]; total: number };

/** 指定したフィルタでの初期状態（空の一覧、offset 0、total 0）を作る。 */
export function initialPagingState(filter: HistoryFilter = 'all'): HistoryPagingState {
  return { filter, items: [], offset: 0, total: 0 };
}

/**
 * Apply a page result. A page whose `offset` is 0 (a fresh load or a refetch of
 * the first page) replaces the accumulator; later offsets append, de-duplicating
 * by id so an overlapping refetch can't double-insert.
 */
export function historyPagingReducer(
  state: HistoryPagingState,
  action: HistoryPagingAction,
): HistoryPagingState {
  switch (action.type) {
    case 'reset':
      // フィルタが切り替わったら、これまでの蓄積結果を破棄して初期状態からやり直す。
      return initialPagingState(action.filter);
    case 'pageLoaded': {
      // offset === 0 は「1 ページ目の新規取得 or 再取得」を意味するため、
      // 既存の蓄積を空にして置き換える。それ以外（2 ページ目以降）は既存の items に追加する。
      const base = action.offset === 0 ? [] : state.items;
      const seen = new Set(base.map((e) => e.id));
      const merged = [...base];
      // 取得済み id と重複しないエントリのみ追加する（オーバーラップした再取得での二重登録防止）。
      for (const entry of action.items) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          merged.push(entry);
        }
      }
      return {
        filter: state.filter,
        items: merged,
        offset: merged.length,
        total: action.total,
      };
    }
    default:
      return state;
  }
}

/** Whether more rows remain to load beyond what's accumulated. */
// 蓄積済み件数がサーバー報告の総件数に満たなければ、まだ読み込める行が残っている。
export function hasMore(state: HistoryPagingState): boolean {
  return state.items.length < state.total;
}

/** Map a UI filter to the request's `state=` param (undefined for "all"). */
// UI 上のフィルタ値を API リクエストパラメータへ変換する。'all' は「絞り込みなし」を
// 意味するため undefined（クエリパラメータ省略）にマップする。
export function filterToStateParam(filter: HistoryFilter): QueryState | undefined {
  return filter === 'all' ? undefined : filter;
}

/**
 * The next offset to request given how many rows are already loaded and the
 * server's `total`, or undefined when everything is loaded. This is the same
 * paging math the reducer applies, lifted out for `useInfiniteQuery`'s
 * `getNextPageParam` (and unit tested directly).
 */
// 読み込み済み件数が総件数未満なら「読み込み済み件数」がそのまま次に要求すべき
// offset になる（0-indexed のページング）。読み込み済み件数が総件数に達していれば
// undefined を返し、useInfiniteQuery に「もう次ページは無い」ことを伝える。
export function nextOffset(loaded: number, total: number): number | undefined {
  return loaded < total ? loaded : undefined;
}

// Recently-used datasource.catalog.schema contexts.
// Persisted to localStorage as per-datasource MRU lists (most-recent first, max 5) so a new
// notebook starts from the last context the user worked in. Pure list logic is
// split out (`pushRecent`) for unit testing; the read/write helpers wrap it with
// safe localStorage access.
//
// ==== ファイルの責務（日本語） ================================================
// 直近使用した datasource.catalog.schema コンテキストを、MRU（Most Recently Used）リスト
// として localStorage に永続化するためのヘルパー群。新規 notebook 作成時に、直前まで使っていたコンテキストを
// 初期値として引き継げるようにする。リストの並べ替えロジック（`pushRecent`）は
// 副作用の無い純粋関数として切り出してあり単体テスト可能。read/write の
// ヘルパーはそれを localStorage への安全なアクセスでラップしたもの。
// ============================================================================

import { principalStorageKey } from '../storage/principalStorage';

/** 1 つの datasource.catalog.schema 実行コンテキスト。 */
export interface ContextValue {
  datasourceId: string;
  catalog: string;
  schema: string;
}

export const RECENT_CONTEXTS_KEY = principalStorageKey('hubble-recent-contexts');
export const MAX_RECENT_CONTEXTS = 5;

/** Two contexts are the same iff datasource, catalog, and schema all match. */
/** datasource、catalog、schema がすべて一致する場合だけ同じコンテキストと判定する。 */
export function sameContext(a: ContextValue, b: ContextValue): boolean {
  return a.datasourceId === b.datasourceId && a.catalog === b.catalog && a.schema === b.schema;
}

/**
 * Insert `next` at the front of the MRU list, removing any existing copy and
 * capping the length (pure — returns a new array). Blank entries are ignored.
 *
 * `next` を同じデータソースの MRU リスト先頭に挿入する。既に同じコンテキストが
 * あれば古い方を取り除き、データソースごとの長さを `max` で頭打ちにする。
 * 副作用は無く、常に新しい配列を返す。catalog/schema が空のコンテキストは
 * そもそも記録しない。
 */
export function pushRecent(
  list: readonly ContextValue[],
  next: ContextValue,
  max = MAX_RECENT_CONTEXTS,
): ContextValue[] {
  if (!next.datasourceId || !next.catalog || !next.schema) return [...list];
  const otherDatasources = list.filter((context) => context.datasourceId !== next.datasourceId);
  const sameDatasource = list.filter(
    (context) => context.datasourceId === next.datasourceId && !sameContext(context, next),
  );
  return [next, ...sameDatasource].slice(0, max).concat(otherDatasources);
}

// SSR やプライベートブラウジング等で localStorage が使えない環境でも
// 例外で落ちないようにするためのガード付きアクセサ。
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Read the persisted recent-context list for a datasource, or every datasource when omitted. */
/** 指定データソースの MRU を読み出す。省略時は全データソース分を返す。 */
export function readRecentContexts(datasourceId?: string): ContextValue[] {
  const ls = safeLocalStorage();
  if (!ls) return [];
  const raw = ls.getItem(RECENT_CONTEXTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 壊れた/型の合わないエントリを除外しつつ、念のため長さも再度キャップする。
    const valid = parsed.filter(
      (c): c is ContextValue =>
        typeof c?.datasourceId === 'string' &&
        typeof c?.catalog === 'string' &&
        typeof c?.schema === 'string',
    );
    if (datasourceId === undefined) return valid;
    return valid
      .filter((context) => context.datasourceId === datasourceId)
      .slice(0, MAX_RECENT_CONTEXTS);
  } catch {
    return [];
  }
}

/** Record a context as most-recently-used and persist the trimmed list. */
/**
 * `next` を最近使ったコンテキストとして記録し、更新後のリストを localStorage
 * へ書き戻す。notebook のコンテキスト（catalog/schema）を変更するたびに
 * 呼ばれる想定。
 */
export function recordRecentContext(next: ContextValue): ContextValue[] {
  const updated = pushRecent(readRecentContexts(), next);
  const ls = safeLocalStorage();
  try {
    ls?.setItem(RECENT_CONTEXTS_KEY, JSON.stringify(updated));
  } catch {
    /* quota — non-fatal */
  }
  return updated;
}

// Recently-used catalog.schema contexts (design.md §5 管理: 最近使った値を復元).
// Persisted to localStorage as an MRU list (most-recent first, max 5) so a new
// notebook starts from the last context the user worked in. Pure list logic is
// split out (`pushRecent`) for unit testing; the read/write helpers wrap it with
// safe localStorage access.
//
// ==== ファイルの責務（日本語） ================================================
// 直近使用した catalog.schema コンテキストを、MRU（Most Recently Used）リスト
// として localStorage に永続化するためのヘルパー群（design.md §5 管理:
// 最近使った値を復元）。新規 notebook 作成時に、直前まで使っていたコンテキストを
// 初期値として引き継げるようにする。リストの並べ替えロジック（`pushRecent`）は
// 副作用の無い純粋関数として切り出してあり単体テスト可能。read/write の
// ヘルパーはそれを localStorage への安全なアクセスでラップしたもの。
// ============================================================================

/** 1 つの catalog.schema コンテキスト。 */
export interface ContextValue {
  catalog: string;
  schema: string;
}

export const RECENT_CONTEXTS_KEY = 'hubble-recent-contexts';
export const MAX_RECENT_CONTEXTS = 5;

/** Two contexts are the same iff catalog and schema both match. */
/** 2 つのコンテキストが同一かどうか（catalog と schema が両方一致する場合のみ true）。 */
export function sameContext(a: ContextValue, b: ContextValue): boolean {
  return a.catalog === b.catalog && a.schema === b.schema;
}

/**
 * Insert `next` at the front of the MRU list, removing any existing copy and
 * capping the length (pure — returns a new array). Blank entries are ignored.
 *
 * `next` を MRU リストの先頭に挿入する。リスト中に既に同じコンテキストが
 * あれば古い方は取り除き（重複を避ける）、リストの長さは `max` で頭打ちにする。
 * 副作用は無く、常に新しい配列を返す。catalog/schema が空のコンテキストは
 * そもそも記録しない。
 */
export function pushRecent(
  list: readonly ContextValue[],
  next: ContextValue,
  max = MAX_RECENT_CONTEXTS,
): ContextValue[] {
  if (!next.catalog || !next.schema) return [...list];
  const without = list.filter((c) => !sameContext(c, next));
  return [next, ...without].slice(0, max);
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

/** Read the persisted recent-context list (most-recent first), or empty. */
/** localStorage から永続化済みの MRU リストを読み出す（新しい順）。無ければ空配列。 */
export function readRecentContexts(): ContextValue[] {
  const ls = safeLocalStorage();
  if (!ls) return [];
  const raw = ls.getItem(RECENT_CONTEXTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 壊れた/型の合わないエントリを除外しつつ、念のため長さも再度キャップする。
    return parsed
      .filter(
        (c): c is ContextValue =>
          typeof c?.catalog === 'string' && typeof c?.schema === 'string',
      )
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

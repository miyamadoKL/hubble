// Recently-used catalog.schema contexts (design.md §5 管理: 最近使った値を復元).
// Persisted to localStorage as an MRU list (most-recent first, max 5) so a new
// notebook starts from the last context the user worked in. Pure list logic is
// split out (`pushRecent`) for unit testing; the read/write helpers wrap it with
// safe localStorage access.

export interface ContextValue {
  catalog: string;
  schema: string;
}

export const RECENT_CONTEXTS_KEY = 'hue-fable-recent-contexts';
export const MAX_RECENT_CONTEXTS = 5;

/** Two contexts are the same iff catalog and schema both match. */
export function sameContext(a: ContextValue, b: ContextValue): boolean {
  return a.catalog === b.catalog && a.schema === b.schema;
}

/**
 * Insert `next` at the front of the MRU list, removing any existing copy and
 * capping the length (pure — returns a new array). Blank entries are ignored.
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

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Read the persisted recent-context list (most-recent first), or empty. */
export function readRecentContexts(): ContextValue[] {
  const ls = safeLocalStorage();
  if (!ls) return [];
  const raw = ls.getItem(RECENT_CONTEXTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
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

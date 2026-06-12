// One-time key-rename migration: copy persisted UI state and unsaved drafts from
// the old `hue-fable-*` localStorage keys to the new `hubble-*` keys, then drop
// the old keys. Runs once on app start (before the zustand `hubble-ui` store is
// created) so an existing browser keeps its theme, open tabs and draft notebooks.

/** Old -> new key pairs for the fixed (non-prefixed) localStorage keys. */
const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['hue-fable-ui', 'hubble-ui'],
  ['hue-fable-workspace', 'hubble-workspace'],
  ['hue-fable-recent-contexts', 'hubble-recent-contexts'],
];

const OLD_DRAFT_PREFIX = 'hue-fable-draft:';
const NEW_DRAFT_PREFIX = 'hubble-draft:';

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Move legacy `hue-fable-*` values to their `hubble-*` equivalents. Each key is
 * copied only when the new key is absent (never clobber a newer value) and the
 * old key is always removed afterwards. No-op when localStorage is unavailable.
 */
export function migrateLegacyStorage(): void {
  const ls = safeLocalStorage();
  if (!ls) return;

  for (const [oldKey, newKey] of RENAMES) {
    const value = ls.getItem(oldKey);
    if (value === null) continue;
    if (ls.getItem(newKey) === null) ls.setItem(newKey, value);
    ls.removeItem(oldKey);
  }

  // Per-draft snapshots use a dynamic suffix, so enumerate the old prefix.
  const oldDraftKeys: string[] = [];
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (key && key.startsWith(OLD_DRAFT_PREFIX)) oldDraftKeys.push(key);
  }
  for (const oldKey of oldDraftKeys) {
    const newKey = NEW_DRAFT_PREFIX + oldKey.slice(OLD_DRAFT_PREFIX.length);
    const value = ls.getItem(oldKey);
    if (value === null) continue;
    if (ls.getItem(newKey) === null) ls.setItem(newKey, value);
    ls.removeItem(oldKey);
  }
}

// Run immediately on import so the migration completes before any store that
// reads `hubble-*` keys is created (main.tsx imports this first).
migrateLegacyStorage();

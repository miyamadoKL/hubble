import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  pushRecent,
  sameContext,
  readRecentContexts,
  recordRecentContext,
  RECENT_CONTEXTS_KEY,
  MAX_RECENT_CONTEXTS,
  type ContextValue,
} from './recentContexts';

const ctx = (catalog: string, schema: string): ContextValue => ({ catalog, schema });

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('sameContext', () => {
  test('matches on both catalog and schema', () => {
    expect(sameContext(ctx('a', 'b'), ctx('a', 'b'))).toBe(true);
    expect(sameContext(ctx('a', 'b'), ctx('a', 'c'))).toBe(false);
    expect(sameContext(ctx('a', 'b'), ctx('x', 'b'))).toBe(false);
  });
});

describe('pushRecent', () => {
  test('inserts at the front (most-recent first)', () => {
    const out = pushRecent([ctx('a', '1')], ctx('b', '2'));
    expect(out).toEqual([ctx('b', '2'), ctx('a', '1')]);
  });

  test('moves an existing entry to the front without duplicating', () => {
    const out = pushRecent([ctx('a', '1'), ctx('b', '2')], ctx('b', '2'));
    expect(out).toEqual([ctx('b', '2'), ctx('a', '1')]);
  });

  test('caps the list length', () => {
    let list: ContextValue[] = [];
    for (let i = 0; i < MAX_RECENT_CONTEXTS + 3; i++) {
      list = pushRecent(list, ctx('c', String(i)));
    }
    expect(list).toHaveLength(MAX_RECENT_CONTEXTS);
    // The most-recent push is first; the oldest were dropped.
    expect(list[0]).toEqual(ctx('c', String(MAX_RECENT_CONTEXTS + 2)));
  });

  test('ignores blank contexts', () => {
    expect(pushRecent([ctx('a', '1')], ctx('', ''))).toEqual([ctx('a', '1')]);
    expect(pushRecent([ctx('a', '1')], ctx('b', ''))).toEqual([ctx('a', '1')]);
  });
});

describe('read / record (localStorage)', () => {
  test('reads back what was recorded, most-recent first', () => {
    recordRecentContext(ctx('tpch', 'sf1'));
    recordRecentContext(ctx('tpch', 'sf10'));
    expect(readRecentContexts()).toEqual([ctx('tpch', 'sf10'), ctx('tpch', 'sf1')]);
  });

  test('record returns the updated trimmed list', () => {
    const out = recordRecentContext(ctx('a', '1'));
    expect(out).toEqual([ctx('a', '1')]);
  });

  test('empty when nothing has been stored', () => {
    expect(readRecentContexts()).toEqual([]);
  });

  test('ignores malformed storage gracefully', () => {
    localStorage.setItem(RECENT_CONTEXTS_KEY, '{not json');
    expect(readRecentContexts()).toEqual([]);
    localStorage.setItem(RECENT_CONTEXTS_KEY, JSON.stringify([{ nope: true }]));
    expect(readRecentContexts()).toEqual([]);
  });
});

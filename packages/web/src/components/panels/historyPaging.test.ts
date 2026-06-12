import { describe, expect, test } from 'vitest';
import type { QueryHistoryEntry } from '@hubble/contracts';
import {
  historyPagingReducer,
  initialPagingState,
  hasMore,
  nextOffset,
  filterToStateParam,
} from './historyPaging';

function entry(id: string): QueryHistoryEntry {
  return {
    id,
    statement: `SELECT ${id}`,
    catalog: 'tpch',
    schema: 'sf1',
    state: 'finished',
    rowCount: 1,
    elapsedMs: 100,
    submittedAt: '2026-06-12T00:00:00.000Z',
  };
}

const page = (ids: string[]) => ids.map(entry);

describe('initialPagingState', () => {
  test('starts empty with the given filter', () => {
    const s = initialPagingState('failed');
    expect(s).toEqual({ filter: 'failed', items: [], offset: 0, total: 0 });
  });
});

describe('historyPagingReducer', () => {
  test('first page (offset 0) seeds items and advances the offset', () => {
    const s = historyPagingReducer(initialPagingState(), {
      type: 'pageLoaded',
      offset: 0,
      items: page(['a', 'b']),
      total: 5,
    });
    expect(s.items.map((e) => e.id)).toEqual(['a', 'b']);
    expect(s.offset).toBe(2);
    expect(s.total).toBe(5);
  });

  test('subsequent pages append', () => {
    let s = historyPagingReducer(initialPagingState(), {
      type: 'pageLoaded',
      offset: 0,
      items: page(['a', 'b']),
      total: 4,
    });
    s = historyPagingReducer(s, {
      type: 'pageLoaded',
      offset: 2,
      items: page(['c', 'd']),
      total: 4,
    });
    expect(s.items.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(s.offset).toBe(4);
  });

  test('offset 0 refetch replaces the accumulator', () => {
    let s = historyPagingReducer(initialPagingState(), {
      type: 'pageLoaded',
      offset: 0,
      items: page(['a', 'b']),
      total: 2,
    });
    s = historyPagingReducer(s, {
      type: 'pageLoaded',
      offset: 0,
      items: page(['x']),
      total: 1,
    });
    expect(s.items.map((e) => e.id)).toEqual(['x']);
    expect(s.offset).toBe(1);
    expect(s.total).toBe(1);
  });

  test('de-duplicates overlapping ids when appending', () => {
    let s = historyPagingReducer(initialPagingState(), {
      type: 'pageLoaded',
      offset: 0,
      items: page(['a', 'b']),
      total: 3,
    });
    // An overlapping append (b repeated) must not double-insert.
    s = historyPagingReducer(s, {
      type: 'pageLoaded',
      offset: 2,
      items: page(['b', 'c']),
      total: 3,
    });
    expect(s.items.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('reset clears items and switches the filter', () => {
    let s = historyPagingReducer(initialPagingState(), {
      type: 'pageLoaded',
      offset: 0,
      items: page(['a']),
      total: 1,
    });
    s = historyPagingReducer(s, { type: 'reset', filter: 'failed' });
    expect(s).toEqual({ filter: 'failed', items: [], offset: 0, total: 0 });
  });
});

describe('hasMore / nextOffset', () => {
  test('hasMore is true while fewer than total are loaded', () => {
    expect(hasMore({ filter: 'all', items: page(['a']), offset: 1, total: 3 })).toBe(true);
    expect(hasMore({ filter: 'all', items: page(['a', 'b', 'c']), offset: 3, total: 3 })).toBe(
      false,
    );
  });

  test('nextOffset returns loaded count until exhausted, then undefined', () => {
    expect(nextOffset(0, 5)).toBe(0);
    expect(nextOffset(2, 5)).toBe(2);
    expect(nextOffset(5, 5)).toBeUndefined();
    expect(nextOffset(6, 5)).toBeUndefined();
  });
});

describe('filterToStateParam', () => {
  test('maps "all" to undefined and others through', () => {
    expect(filterToStateParam('all')).toBeUndefined();
    expect(filterToStateParam('failed')).toBe('failed');
    expect(filterToStateParam('running')).toBe('running');
  });
});

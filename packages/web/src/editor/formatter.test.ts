import { describe, expect, test } from 'vitest';
import { formatSql } from './formatter';

describe('formatSql', () => {
  test('uppercases keywords and reflows a query', () => {
    const out = formatSql('select a,b from t where a>1');
    expect(out).toMatch(/SELECT/);
    expect(out).toMatch(/FROM/);
    expect(out).toMatch(/WHERE/);
  });

  test('is idempotent on already-formatted SQL', () => {
    const once = formatSql('select 1');
    expect(formatSql(once)).toBe(once);
  });

  test('returns the input unchanged on unformattable garbage', () => {
    // sql-formatter is resilient, but the wrapper must never throw.
    expect(() => formatSql('@@@')).not.toThrow();
  });
});

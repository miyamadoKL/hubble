import { describe, expect, it } from 'vitest';
import { parseExplainStatement } from './explainStatement';

describe('parseExplainStatement', () => {
  it('returns null for non-EXPLAIN statements', () => {
    expect(parseExplainStatement('SELECT 1')).toBeNull();
  });

  it('detects plain EXPLAIN without analyze', () => {
    expect(parseExplainStatement('EXPLAIN SELECT 1')).toEqual({
      hasAnalyze: false,
      inner: 'SELECT 1',
    });
  });

  it('detects EXPLAIN ANALYZE and extracts inner statement', () => {
    expect(parseExplainStatement('EXPLAIN ANALYZE SELECT 1')).toEqual({
      hasAnalyze: true,
      inner: 'SELECT 1',
    });
  });

  it('detects EXPLAIN ANALYZE VERBOSE', () => {
    expect(parseExplainStatement('EXPLAIN ANALYZE VERBOSE INSERT INTO t VALUES (1)')).toEqual({
      hasAnalyze: true,
      inner: 'INSERT INTO t VALUES (1)',
    });
  });

  it('detects INCLUDE ANALYZE in parenthesized options', () => {
    expect(
      parseExplainStatement('EXPLAIN (TYPE IO, FORMAT JSON, INCLUDE ANALYZE) SELECT 1'),
    ).toEqual({
      hasAnalyze: true,
      inner: 'SELECT 1',
    });
  });

  it('ignores semicolons inside quoted strings when scanning options', () => {
    expect(parseExplainStatement("EXPLAIN (FORMAT TEXT) SELECT 'a;b'")).toEqual({
      hasAnalyze: false,
      inner: "SELECT 'a;b'",
    });
  });
});

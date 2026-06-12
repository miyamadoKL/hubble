import { describe, expect, test } from 'vitest';
import { classifyStatement, statementHasLimit, withAutoLimit } from './sql';

describe('classifyStatement', () => {
  test('detects the leading keyword, ignoring comments and whitespace', () => {
    expect(classifyStatement('SELECT 1')).toBe('select');
    expect(classifyStatement('  \n  select * from t')).toBe('select');
    expect(classifyStatement('-- a comment\nSELECT 1')).toBe('select');
    expect(classifyStatement('/* block */ WITH x AS (SELECT 1) SELECT * FROM x')).toBe('with');
    expect(classifyStatement('EXPLAIN SELECT 1')).toBe('explain');
    expect(classifyStatement('INSERT INTO t VALUES (1)')).toBe('insert');
    expect(classifyStatement('SHOW TABLES')).toBe('show');
    expect(classifyStatement('DESCRIBE t')).toBe('describe');
    expect(classifyStatement('TABLE orders')).toBe('select');
    expect(classifyStatement('VALUES (1), (2)')).toBe('select');
  });

  test('empty / whitespace / comment-only → empty', () => {
    expect(classifyStatement('')).toBe('empty');
    expect(classifyStatement('   \n\t')).toBe('empty');
    expect(classifyStatement('-- just a comment')).toBe('empty');
  });

  test('non-row-returning DDL falls into other', () => {
    expect(classifyStatement('CREATE TABLE t (a int)')).toBe('other');
    expect(classifyStatement('DROP TABLE t')).toBe('other');
  });
});

describe('statementHasLimit', () => {
  test('true for top-level LIMIT', () => {
    expect(statementHasLimit('SELECT * FROM t LIMIT 10')).toBe(true);
    expect(statementHasLimit('select a from t limit 5')).toBe(true);
  });

  test('true for FETCH FIRST', () => {
    expect(statementHasLimit('SELECT * FROM t FETCH FIRST 10 ROWS ONLY')).toBe(true);
  });

  test('false when there is none', () => {
    expect(statementHasLimit('SELECT * FROM t')).toBe(false);
  });

  test('the word "limit" inside a string or comment does not count', () => {
    expect(statementHasLimit("SELECT 'limit' AS x FROM t")).toBe(false);
    expect(statementHasLimit('SELECT * FROM t -- limit 5')).toBe(false);
    expect(statementHasLimit('SELECT * FROM t /* limit 5 */')).toBe(false);
  });
});

describe('withAutoLimit', () => {
  test('appends LIMIT to a LIMIT-less SELECT', () => {
    const r = withAutoLimit('SELECT * FROM orders', 5000);
    expect(r.applied).toBe(true);
    expect(r.sql).toBe('SELECT * FROM orders\nLIMIT 5000');
  });

  test('lowercase select is handled too', () => {
    const r = withAutoLimit('select * from orders', 100);
    expect(r.applied).toBe(true);
    expect(r.sql).toBe('select * from orders\nLIMIT 100');
  });

  test('leaves a SELECT that already has LIMIT untouched', () => {
    const r = withAutoLimit('SELECT * FROM orders LIMIT 10', 5000);
    expect(r.applied).toBe(false);
    expect(r.sql).toBe('SELECT * FROM orders LIMIT 10');
  });

  test('never appends to INSERT', () => {
    const r = withAutoLimit('INSERT INTO t SELECT * FROM s', 5000);
    expect(r.applied).toBe(false);
    expect(r.sql).toBe('INSERT INTO t SELECT * FROM s');
  });

  test('never appends to EXPLAIN', () => {
    const r = withAutoLimit('EXPLAIN SELECT * FROM orders', 5000);
    expect(r.applied).toBe(false);
  });

  test('appends to a WITH (CTE) query', () => {
    const r = withAutoLimit('WITH x AS (SELECT 1) SELECT * FROM x', 50);
    expect(r.applied).toBe(true);
    expect(r.sql).toBe('WITH x AS (SELECT 1) SELECT * FROM x\nLIMIT 50');
  });

  test('does not append to SHOW / DESCRIBE', () => {
    expect(withAutoLimit('SHOW TABLES', 100).applied).toBe(false);
    expect(withAutoLimit('DESCRIBE orders', 100).applied).toBe(false);
  });

  test('preserves a trailing semicolon after the inserted LIMIT', () => {
    const r = withAutoLimit('SELECT * FROM orders;', 200);
    expect(r.applied).toBe(true);
    expect(r.sql).toBe('SELECT * FROM orders\nLIMIT 200;');
  });
});

import { describe, expect, it } from 'vitest';
import type { Permission } from '@hubble/contracts';
import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { classifyStatementWrite, assertQueryWriteAllowed } from './writeCheck';

const readOnlyRole = {
  name: 'readonly',
  permissions: new Set<Permission>(),
  datasources: ['*'],
};

describe('classifyStatementWrite', () => {
  it('allows SELECT and denies INSERT immediately', () => {
    expect(classifyStatementWrite('SELECT 1')).toBe('allow');
    expect(classifyStatementWrite('INSERT INTO t VALUES (1)')).toBe('deny');
  });

  it('routes WITH to IO explain', () => {
    expect(classifyStatementWrite('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('explain');
  });

  it('routes multi-statement SQL to IO explain even when the first keyword is SELECT', () => {
    expect(classifyStatementWrite('SELECT 1; INSERT INTO t VALUES (1)')).toBe('explain');
  });

  it('ignores semicolons inside string literals and quoted identifiers', () => {
    expect(classifyStatementWrite("SELECT 'a;b'")).toBe('allow');
    expect(classifyStatementWrite('SELECT "col;name" FROM t')).toBe('allow');
    expect(classifyStatementWrite('SELECT `tbl;name` FROM t')).toBe('allow');
  });

  it('allows a single trailing semicolon', () => {
    expect(classifyStatementWrite('SELECT 1;')).toBe('allow');
  });

  it('allows plain EXPLAIN', () => {
    expect(classifyStatementWrite('EXPLAIN SELECT 1')).toBe('allow');
  });

  it('classifies EXPLAIN ANALYZE via inner statement', () => {
    expect(classifyStatementWrite('EXPLAIN ANALYZE SELECT 1')).toBe('allow');
    expect(classifyStatementWrite('EXPLAIN ANALYZE INSERT INTO t VALUES (1)')).toBe('deny');
  });

  it('classifies EXPLAIN with INCLUDE ANALYZE option via inner statement', () => {
    expect(classifyStatementWrite('EXPLAIN (INCLUDE ANALYZE) DELETE FROM t')).toBe('deny');
  });

  it.each([
    "SELECT * FROM t INTO OUTFILE '/tmp/result.csv'",
    "SELECT * FROM t INTO DUMPFILE '/tmp/result.bin'",
    'SELECT * INTO new_table FROM source_table',
    'SELECT value INTO @result FROM t',
    'SET SESSION TRANSACTION READ WRITE',
    'SET TRANSACTION READ WRITE',
  ])('denies a dialect statement with a write side effect: %s', (statement) => {
    expect(classifyStatementWrite(statement)).toBe('deny');
  });

  it.each([
    'SELECT into_col FROM t',
    "SELECT 'x INTO y' FROM t",
    'SELECT a -- INTO\n FROM t',
    'SELECT a /* INTO */ FROM t',
    'SELECT "into" FROM t',
    'SELECT `into` FROM t',
    'SELECT a FROM t WHERE b IN (1, 2)',
    'SELECT a FROM (SELECT b FROM other) x',
    'SET SESSION TRANSACTION READ ONLY',
    "SET SESSION time_zone = 'READ WRITE'",
    'SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  ])('allows a statement without a top-level bare write phrase: %s', (statement) => {
    expect(classifyStatementWrite(statement)).toBe('allow');
  });
});

describe('assertQueryWriteAllowed', () => {
  it('allows writes for a role with query.write', async () => {
    await expect(
      assertQueryWriteAllowed({
        statement: 'INSERT INTO t VALUES (1)',
        role: { name: 'writer', permissions: new Set(['query.write']), datasources: ['*'] },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects INSERT for read-only role without IO explain', async () => {
    await expect(
      assertQueryWriteAllowed({
        statement: 'INSERT INTO t VALUES (1)',
        role: readOnlyRole,
      }),
    ).rejects.toMatchObject({
      status: 403,
      detail: { code: WRITE_NOT_ALLOWED },
    });
  });

  it('rejects multi-statement SQL for read-only role without IO explain', async () => {
    await expect(
      assertQueryWriteAllowed({
        statement: 'SELECT 1; INSERT INTO t VALUES (1)',
        role: readOnlyRole,
      }),
    ).rejects.toMatchObject({
      status: 403,
      detail: { code: WRITE_NOT_ALLOWED },
    });
  });
});

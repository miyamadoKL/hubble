import { describe, expect, it } from 'vitest';
import type { Permission } from '@hubble/contracts';
import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { classifyStatementWrite, assertQueryWriteAllowed } from './writeCheck';
import { builtInUnrestrictedRole } from './resolve';

const readOnlyRole = {
  name: 'readonly',
  permissions: new Set<Permission>(),
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
});

describe('assertQueryWriteAllowed', () => {
  it('no-ops for unrestricted role', async () => {
    await expect(
      assertQueryWriteAllowed({
        statement: 'INSERT INTO t VALUES (1)',
        role: builtInUnrestrictedRole(),
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

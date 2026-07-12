/**
 * sql/errors.ts のドライバエラーマッピングテスト。
 */
import { describe, it, expect } from 'vitest';
import { TrinoQueryError, TrinoTransportError } from '../../errors';
import { classifyFailure } from '../../schedule/retry';
import { throwMysqlDriverError, throwPgDriverError } from './errors';

function expectTransport(fn: () => void): void {
  try {
    fn();
    expect.fail('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TrinoTransportError);
    expect(classifyFailure(err)).toBe('transient');
  }
}

function expectUserError(fn: () => void): void {
  try {
    fn();
    expect.fail('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TrinoQueryError);
    expect((err as TrinoQueryError).trino.errorType).toBe('USER_ERROR');
    expect((err as TrinoQueryError).status).toBe(400);
    expect(classifyFailure(err)).toBe('deterministic');
  }
}

function expectInternalError(fn: () => void): void {
  try {
    fn();
    expect.fail('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TrinoQueryError);
    expect((err as TrinoQueryError).trino.errorType).toBe('INTERNAL_ERROR');
    expect((err as TrinoQueryError).status).toBe(502);
    expect(classifyFailure(err)).toBe('transient');
  }
}

function expectDeterministicInfrastructure(fn: () => void): void {
  try {
    fn();
    expect.fail('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TrinoQueryError);
    expect((err as TrinoQueryError).trino.errorType).toBe('EXTERNAL_ERROR');
    expect((err as TrinoQueryError).status).toBe(502);
    expect(classifyFailure(err)).toBe('deterministic');
  }
}

describe('throwMysqlDriverError', () => {
  it.each([
    [1040, 'Too many connections'],
    [1041, 'Out of memory'],
    [1053, 'Server shutdown in progress'],
  ])('classifies errno %i as transient', (errno, sqlMessage) => {
    expectTransport(() => throwMysqlDriverError({ errno, sqlMessage }));
  });

  it.each([
    [1205, 'Lock wait timeout exceeded'],
    [1213, 'Deadlock found when trying to get lock'],
  ])('classifies retryable transaction errno %i as transient', (errno, sqlMessage) => {
    expectTransport(() => throwMysqlDriverError({ errno, sqlMessage }));
  });

  it('classifies unknown table errno as USER_ERROR', () => {
    expectUserError(() =>
      throwMysqlDriverError({ errno: 1146, sqlMessage: "Table 't' doesn't exist" }),
    );
  });

  it('classifies duplicate key errno as USER_ERROR', () => {
    expectUserError(() =>
      throwMysqlDriverError({ errno: 1062, sqlMessage: "Duplicate entry '1' for key 'PRIMARY'" }),
    );
  });

  it('classifies an existing table as a deterministic statement error', () => {
    expectUserError(() =>
      throwMysqlDriverError({ errno: 1050, sqlMessage: "Table 'events' already exists" }),
    );
  });

  it('classifies an unknown driver errno as a retryable engine error', () => {
    expectInternalError(() =>
      throwMysqlDriverError({ errno: 1999, sqlMessage: 'Unknown engine failure' }),
    );
  });
});

describe('throwPgDriverError', () => {
  it.each([
    ['23505', 'duplicate key value violates unique constraint'],
    ['22012', 'division by zero'],
    ['54001', 'statement too complex'],
  ])('classifies deterministic SQLSTATE %s as USER_ERROR', (code, message) => {
    expectUserError(() => throwPgDriverError({ code, message }));
  });

  it.each([
    ['40001', 'could not serialize access'],
    ['40P01', 'deadlock detected'],
    ['55P03', 'could not obtain lock'],
  ])('classifies retryable SQLSTATE %s as transient', (code, message) => {
    expectTransport(() => throwPgDriverError({ code, message }));
  });

  it('classifies an unknown SQLSTATE as a retryable engine error', () => {
    expectInternalError(() => throwPgDriverError({ code: 'XX999', message: 'unknown failure' }));
  });

  it('classifies authentication failure as deterministic infrastructure failure', () => {
    expectDeterministicInfrastructure(() =>
      throwPgDriverError({ code: '28P01', message: 'password authentication failed' }),
    );
  });
});

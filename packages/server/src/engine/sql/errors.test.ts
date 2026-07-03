/**
 * sql/errors.ts のドライバエラーマッピングテスト。
 */
import { describe, it, expect } from 'vitest';
import { TrinoQueryError, TrinoTransportError } from '../../errors';
import { throwMysqlDriverError } from './errors';

function expectTransport(fn: () => void): void {
  try {
    fn();
    expect.fail('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TrinoTransportError);
  }
}

function expectUserError(fn: () => void): void {
  try {
    fn();
    expect.fail('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TrinoQueryError);
    expect((err as TrinoQueryError).trino.errorType).toBe('USER_ERROR');
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

  it('classifies unknown table errno as USER_ERROR', () => {
    expectUserError(() => throwMysqlDriverError({ errno: 1146, sqlMessage: "Table 't' doesn't exist" }));
  });
});
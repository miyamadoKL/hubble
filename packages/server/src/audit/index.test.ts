import { describe, expect, it, vi } from 'vitest';
import { AuditLogger } from './index';

describe('AuditLogger', () => {
  it('logs and swallows repository failures', async () => {
    const err = new Error('db down');
    const logError = vi.fn();
    const logger = new AuditLogger(
      {
        record: async () => {
          throw err;
        },
        listForTest: async () => [],
      },
      logError,
    );

    await expect(
      logger.record({
        actor: 'alice',
        action: 'query.execute',
        target: 'q_1',
        datasource: 'trino-default',
        detail: {},
      }),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith('audit log write failed; continuing request', err);
  });
});

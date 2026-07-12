/** DB 未関連 object の即時削除と durable fallback を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import type { ResultStore } from './store';
import { cleanupUnlinkedResultObject } from './objectCleanup';

describe('cleanupUnlinkedResultObject', () => {
  it('即時削除に成功した場合は outbox へ登録しない', async () => {
    const deleteObject = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);

    await cleanupUnlinkedResultObject('results/q1.gz', {
      store: { delete: deleteObject } as unknown as ResultStore,
      deletions: { enqueue, isReferenced: vi.fn(async () => false) },
    });

    expect(deleteObject).toHaveBeenCalledWith('results/q1.gz');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('即時削除に失敗した場合は outbox へ登録する', async () => {
    const enqueue = vi.fn(async () => undefined);
    await cleanupUnlinkedResultObject('results/q1.gz', {
      store: {
        delete: vi.fn(async () => {
          throw new Error('S3 unavailable');
        }),
      } as unknown as ResultStore,
      deletions: { enqueue, isReferenced: vi.fn(async () => false) },
      now: () => Date.parse('2026-07-12T00:00:00.000Z'),
    });

    expect(enqueue).toHaveBeenCalledWith(['results/q1.gz'], '2026-07-12T00:00:00.000Z');
  });

  it('live reference がある object は削除しない', async () => {
    const deleteObject = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);

    await cleanupUnlinkedResultObject('results/q1.gz', {
      store: { delete: deleteObject } as unknown as ResultStore,
      deletions: { enqueue, isReferenced: vi.fn(async () => true) },
    });

    expect(deleteObject).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('live reference を確認できない場合は直接削除せず outbox へ登録する', async () => {
    const deleteObject = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);

    await cleanupUnlinkedResultObject('results/q1.gz', {
      store: { delete: deleteObject } as unknown as ResultStore,
      deletions: {
        enqueue,
        isReferenced: vi.fn(async () => {
          throw new Error('DB unavailable');
        }),
      },
    });

    expect(deleteObject).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

/**
 * DB へ関連付けられなかった ResultStore object の後始末を一元管理する。
 */
import type { ResultObjectDeletionRepository } from '../store/resultObjectDeletions';
import type { ResultStore } from './store';

/** object 削除に失敗した場合の永続再試行キュー。 */
export type ResultObjectDeletionQueue = Pick<
  ResultObjectDeletionRepository,
  'enqueue' | 'isReferenced'
>;

/** 未関連 object の後始末に必要な依存。 */
export interface UnlinkedResultCleanupOptions {
  store: ResultStore;
  deletions: ResultObjectDeletionQueue;
  now?: () => number;
  logWarn?: (message: string, error?: unknown) => void;
}

/** 未関連 object を削除し、失敗時は durable outbox へ登録する。 */
export async function cleanupUnlinkedResultObject(
  key: string,
  options: UnlinkedResultCleanupOptions,
): Promise<void> {
  try {
    if (await options.deletions.isReferenced(key)) return;
  } catch (referenceError) {
    await deferDeletion(key, options, referenceError);
    return;
  }
  try {
    await options.store.delete(key);
    return;
  } catch (deleteError) {
    await deferDeletion(key, options, deleteError);
  }
}

async function deferDeletion(
  key: string,
  options: UnlinkedResultCleanupOptions,
  cause: unknown,
): Promise<void> {
  try {
    const nowIso = new Date(options.now?.() ?? Date.now()).toISOString();
    await options.deletions.enqueue([key], nowIso);
    options.logWarn?.(`result object deletion deferred for ${key}`, cause);
  } catch (enqueueError) {
    options.logWarn?.(`failed to defer deletion of result object ${key}`, {
      cause,
      enqueueError,
    });
  }
}

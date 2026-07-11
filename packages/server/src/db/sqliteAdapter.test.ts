// SQLite の単一接続でトランザクション境界が並行操作から隔離されることを検証する。
import { describe, expect, test } from 'vitest';
import type { SqlDatabase } from './sqlDatabase';
import { openSqlite } from './sqliteAdapter';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function openTestDatabase(): Promise<SqlDatabase> {
  const db = openSqlite(':memory:');
  await db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  return db;
}

async function labels(db: SqlDatabase): Promise<string[]> {
  const rows = await db.query<{ label: string }>('SELECT label FROM events ORDER BY id');
  return rows.map((row) => row.label);
}

describe('SqliteDatabase operation isolation', () => {
  test('ロールバック中の通常書き込みを次の境界まで待機させる', async () => {
    const db = await openTestDatabase();
    const entered = deferred<void>();
    const release = deferred<void>();

    try {
      const transaction = db.transaction(async (tx) => {
        await tx.run('INSERT INTO events (id, label) VALUES (?, ?)', [1, 'rolled-back']);
        entered.resolve();
        await release.promise;
        throw new Error('rollback');
      });
      await entered.promise;

      let outsideSettled = false;
      const outside = db
        .run('INSERT INTO events (id, label) VALUES (?, ?)', [2, 'outside'])
        .then(() => {
          outsideSettled = true;
        });
      await Promise.resolve();
      expect(outsideSettled).toBe(false);

      release.resolve();
      await expect(transaction).rejects.toThrow('rollback');
      await outside;
      expect(await labels(db)).toEqual(['outside']);
    } finally {
      await db.close();
    }
  });

  test('並行トランザクションを開始順に直列化する', async () => {
    const db = await openTestDatabase();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    try {
      const first = db.transaction(async (tx) => {
        order.push('first-start');
        await tx.run('INSERT INTO events (id, label) VALUES (?, ?)', [1, 'first']);
        firstEntered.resolve();
        await releaseFirst.promise;
        order.push('first-end');
      });
      await firstEntered.promise;

      const second = db.transaction(async (tx) => {
        order.push('second-start');
        await tx.run('INSERT INTO events (id, label) VALUES (?, ?)', [2, 'second']);
        order.push('second-end');
      });
      await Promise.resolve();
      expect(order).toEqual(['first-start']);

      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
      expect(await labels(db)).toEqual(['first', 'second']);
    } finally {
      await db.close();
    }
  });

  test('commit後に通常操作を開始し、callback用handleは同じ境界を再利用する', async () => {
    const db = await openTestDatabase();
    const entered = deferred<void>();
    const release = deferred<void>();
    let retainedTx: SqlDatabase | undefined;

    try {
      const transaction = db.transaction(async (tx) => {
        retainedTx = tx;
        await tx.transaction(async (nested) => {
          await nested.run('INSERT INTO events (id, label) VALUES (?, ?)', [1, 'committed']);
        });
        entered.resolve();
        await release.promise;
      });
      await entered.promise;

      let outsideSettled = false;
      const outside = db
        .run('INSERT INTO events (id, label) VALUES (?, ?)', [2, 'after-commit'])
        .then(() => {
          outsideSettled = true;
        });
      await Promise.resolve();
      expect(outsideSettled).toBe(false);

      release.resolve();
      await transaction;
      await outside;
      expect(await labels(db)).toEqual(['committed', 'after-commit']);
      await expect(
        retainedTx!.run('INSERT INTO events (id, label) VALUES (?, ?)', [3, 'late']),
      ).rejects.toThrow('no longer active');
    } finally {
      await db.close();
    }
  });
});

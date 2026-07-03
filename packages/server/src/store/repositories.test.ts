/**
 * `NotebookRepository` / `SavedQueryRepository` / `HistoryRepository`
 * （それぞれ notebooks.ts / savedQueries.ts / history.ts）を横断して検証する
 * テストスイート。dbBackends（SQLite 常時、TEST_DATABASE_URL 設定時は
 * PostgreSQL も追加）でパラメタライズし、両方言で同じ SQL が同じ結果になる
 * ことを保証する契約レベルのテスト。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { dbBackends } from '../test/dbBackends';
import { NotebookRepository } from './notebooks';
import { SavedQueryRepository } from './savedQueries';
import { HistoryRepository } from './history';

/**
 * Repository CRUD suite, parameterized over every available backend. SQLite
 * always runs; PostgreSQL runs only when `TEST_DATABASE_URL` is set (see
 * test/dbBackends.ts). This is the contract-level assurance that the same SQL
 * behaves identically on both dialects.
 */
for (const backend of dbBackends) {
  describe(`repositories on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    async function open(): Promise<SqlDatabase> {
      db = await backend.open();
      return db;
    }

    describe('NotebookRepository', () => {
      // 作成→一覧→取得→更新→検索（LIKE ワイルドカードのエスケープ含む）→
      // 削除の一連のライフサイクルと、owner による隔離を検証する。
      it('creates, lists, gets, updates, searches, deletes; owner-scoped', async () => {
        const repo = new NotebookRepository(await open());

        const created = await repo.create('alice', { name: 'Sales', description: 'q3 sales' });
        expect(created.id).toMatch(/^nb_/);
        expect(created.cells).toEqual([]);

        // Owner isolation: bob sees nothing.
        expect(await repo.list('bob')).toEqual([]);
        expect(await repo.get('bob', created.id)).toBeUndefined();

        const list = await repo.list('alice');
        expect(list).toHaveLength(1);
        expect(list[0]!.name).toBe('Sales');

        const got = await repo.get('alice', created.id);
        expect(got?.name).toBe('Sales');

        const updated = await repo.update('alice', created.id, {
          name: 'Renamed',
          description: 'updated',
          cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 1' }],
          variables: [],
          context: { catalog: 'tpch' },
        });
        expect(updated?.name).toBe('Renamed');
        expect(updated?.cells).toHaveLength(1);

        expect(await repo.list('alice', 'Renam')).toHaveLength(1);
        expect(await repo.list('alice', 'zzz')).toHaveLength(0);
        // LIKE wildcards in the query are escaped, not treated as patterns.
        expect(await repo.list('alice', '%')).toHaveLength(0);

        expect(await repo.delete('bob', created.id)).toBe(false);
        expect(await repo.delete('alice', created.id)).toBe(true);
        expect(await repo.get('alice', created.id)).toBeUndefined();
      });
    });

    describe('SavedQueryRepository', () => {
      // お気に入り優先の並び順、検索、更新、削除、owner による隔離を検証する。
      it('orders favorites first, searches, updates, deletes; owner-scoped', async () => {
        const repo = new SavedQueryRepository(await open());

        await repo.create('alice', { name: 'plain', statement: 'SELECT 1' });
        const fav = await repo.create('alice', {
          name: 'favorite',
          statement: 'SELECT 2',
          isFavorite: true,
          catalog: 'tpch',
          schema: 'tiny',
          datasourceId: 'trino-default',
        });
        expect(fav.id).toMatch(/^sq_/);

        const list = await repo.list('alice');
        expect(list).toHaveLength(2);
        expect(list[0]!.id).toBe(fav.id); // favorites first
        expect(list[0]!.isFavorite).toBe(true);
        expect(list[0]!.catalog).toBe('tpch');
        expect(list[0]!.datasourceId).toBe('trino-default');

        expect(await repo.list('alice', 'SELECT 2')).toHaveLength(1);
        expect(await repo.list('bob')).toEqual([]);

        const updated = await repo.update('alice', fav.id, {
          name: 'favorite',
          description: 'd',
          statement: 'SELECT 3',
          isFavorite: false,
          datasourceId: 'mysql-1',
        });
        expect(updated?.statement).toBe('SELECT 3');
        expect(updated?.isFavorite).toBe(false);
        expect(updated?.datasourceId).toBe('mysql-1');

        expect(await repo.delete('alice', fav.id)).toBe(true);
        expect(await repo.delete('alice', fav.id)).toBe(false);
      });
    });

    describe('HistoryRepository', () => {
      // 投入時の insert、確定時の update、state による絞り込み、
      // ページング、owner による隔離を検証する。
      it('inserts, updates on settle, filters by state, paginates; owner-scoped', async () => {
        const repo = new HistoryRepository(await open());

        await repo.insert({
          id: 'h1',
          statement: 'SELECT * FROM nation',
          catalog: 'tpch',
          schema: 'tiny',
          state: 'running',
          owner: 'alice',
          datasourceId: 'trino-default',
          submittedAt: '2026-01-01T00:00:00.000Z',
        });
        await repo.insert({
          id: 'h2',
          statement: 'SELECT bad',
          state: 'running',
          owner: 'alice',
          datasourceId: 'trino-default',
          submittedAt: '2026-01-01T00:01:00.000Z',
        });
        await repo.insert({
          id: 'h3',
          statement: 'SELECT 1',
          state: 'finished',
          owner: 'bob',
          datasourceId: 'trino-default',
          submittedAt: '2026-01-01T00:02:00.000Z',
        });

        const h1 = await repo.get('alice', 'h1');
        expect(h1?.datasourceId).toBe('trino-default');

        await repo.update('h1', { state: 'finished', rowCount: 25, elapsedMs: 120 });
        await repo.update('h2', {
          state: 'failed',
          rowCount: 0,
          elapsedMs: 5,
          errorMessage: 'boom',
        });

        const got = await repo.get('alice', 'h1');
        expect(got?.state).toBe('finished');
        expect(got?.rowCount).toBe(25);
        expect(got?.elapsedMs).toBe(120);
        expect(got?.catalog).toBe('tpch');

        // Owner isolation.
        expect(await repo.get('alice', 'h3')).toBeUndefined();

        const all = await repo.list('alice', {});
        expect(all.total).toBe(2);
        // Most recent submitted_at first.
        expect(all.items.map((e) => e.id)).toEqual(['h2', 'h1']);

        const failed = await repo.list('alice', { state: 'failed' });
        expect(failed.total).toBe(1);
        expect(failed.items[0]!.errorMessage).toBe('boom');

        const page = await repo.list('alice', { offset: 0, limit: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.total).toBe(2);
      });
    });
  });
}

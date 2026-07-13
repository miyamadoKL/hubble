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
import { DocumentShareRepository, type ShareAccessor } from './documentShares';
import { NotebookRepository } from './notebooks';
import { SavedQueryRepository } from './savedQueries';
import { HistoryRepository } from './history';

function accessor(user: string, groups: readonly string[] = [], role = 'member'): ShareAccessor {
  return { user, groups, role };
}

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

    async function openNotebookRepo(): Promise<{
      repo: NotebookRepository;
      shares: DocumentShareRepository;
    }> {
      const database = await open();
      const shares = new DocumentShareRepository(database);
      return { repo: new NotebookRepository(database, shares), shares };
    }

    async function openSavedQueryRepo(): Promise<{
      repo: SavedQueryRepository;
      shares: DocumentShareRepository;
    }> {
      const database = await open();
      const shares = new DocumentShareRepository(database);
      return { repo: new SavedQueryRepository(database, shares), shares };
    }

    describe('NotebookRepository', () => {
      it('creates, lists, gets, updates, searches, deletes; owner-scoped', async () => {
        const { repo } = await openNotebookRepo();

        const created = await repo.create('alice', { name: 'Sales', description: 'q3 sales' });
        expect(created.id).toMatch(/^nb_/);
        expect(created.cells).toEqual([]);
        expect(created.revision).toBe(1);

        expect(await repo.list(accessor('bob'))).toEqual([]);
        expect(await repo.get(accessor('bob'), created.id)).toBeUndefined();

        const list = await repo.list(accessor('alice'));
        expect(list).toHaveLength(1);
        expect(list[0]!.name).toBe('Sales');
        expect(list[0]!.myPermission).toBe('owner');

        const got = await repo.get(accessor('alice'), created.id);
        expect(got?.name).toBe('Sales');
        expect(got?.myPermission).toBe('owner');

        const updated = await repo.update(accessor('alice'), created.id, {
          revision: created.revision,
          name: 'Renamed',
          description: 'updated',
          cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 1' }],
          variables: [],
          context: { catalog: 'tpch' },
        });
        expect(updated).not.toBe('forbidden');
        if (updated === 'forbidden' || updated === 'conflict' || updated === undefined) {
          throw new Error('expected notebook update');
        }
        expect(updated.name).toBe('Renamed');
        expect(updated.cells).toHaveLength(1);
        expect(updated.revision).toBe(2);

        expect(
          await repo.update(accessor('alice'), created.id, {
            revision: created.revision,
            name: 'Stale overwrite',
            description: 'stale',
            cells: [],
            variables: [],
            context: {},
          }),
        ).toBe('conflict');
        expect(await repo.get(accessor('alice'), created.id)).toMatchObject({
          name: 'Renamed',
          revision: 2,
        });

        expect(await repo.list(accessor('alice'), 'Renam')).toHaveLength(1);
        expect(await repo.list(accessor('alice'), 'zzz')).toHaveLength(0);
        expect(await repo.list(accessor('alice'), '%')).toHaveLength(0);

        expect(await repo.delete(accessor('bob'), created.id)).toBe(false);
        expect(await repo.delete(accessor('alice'), created.id)).toBe(true);
        expect(await repo.get(accessor('alice'), created.id)).toBeUndefined();
      });

      it('supports shared view/edit access and owner-only delete', async () => {
        const { repo, shares } = await openNotebookRepo();
        const created = await repo.create('alice', { name: 'Shared nb', description: 'd' });
        await shares.replaceForDocument(
          'notebook',
          created.id,
          [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
          'alice',
        );

        expect(await repo.get(accessor('bob'), created.id)).toMatchObject({
          owner: 'alice',
          myPermission: 'view',
        });
        expect(
          await repo.update(accessor('bob'), created.id, {
            revision: created.revision,
            name: 'Nope',
            description: 'd',
            cells: [],
            variables: [],
            context: {},
          }),
        ).toBe('forbidden');
        expect(await repo.delete(accessor('bob'), created.id)).toBe('forbidden');

        await shares.replaceForDocument(
          'notebook',
          created.id,
          [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
          'alice',
        );
        const updated = await repo.update(accessor('bob'), created.id, {
          revision: created.revision,
          name: 'Bob edit',
          description: 'd',
          cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 1' }],
          variables: [],
          context: {},
        });
        expect(updated).toMatchObject({ name: 'Bob edit', myPermission: 'edit', owner: 'alice' });
        expect(await repo.list(accessor('bob'))).toHaveLength(1);
        expect(await repo.get(accessor('carol'), created.id)).toBeUndefined();
      });

      it('does not expose a notebook through an unknown share permission', async () => {
        const { repo } = await openNotebookRepo();
        const created = await repo.create('alice', { name: 'Private nb' });
        await db.run(
          `INSERT INTO document_shares
             (id, document_type, document_id, subject_type, subject_value, permission, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'shr_invalid_permission',
            'notebook',
            created.id,
            'user',
            'bob',
            'future-permission',
            'alice',
            new Date().toISOString(),
          ],
        );

        expect(await repo.list(accessor('bob'))).toEqual([]);
      });
    });

    describe('SavedQueryRepository', () => {
      it('orders favorites first, searches, updates, deletes; owner-scoped', async () => {
        const { repo } = await openSavedQueryRepo();

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

        const list = await repo.list(accessor('alice'));
        expect(list).toHaveLength(2);
        expect(list[0]!.id).toBe(fav.id);
        expect(list[0]!.isFavorite).toBe(true);
        expect(list[0]!.catalog).toBe('tpch');
        expect(list[0]!.datasourceId).toBe('trino-default');

        expect(await repo.list(accessor('alice'), 'SELECT 2')).toHaveLength(1);
        expect(await repo.list(accessor('bob'))).toEqual([]);

        const updated = await repo.update(accessor('alice'), fav.id, {
          name: 'favorite',
          description: 'd',
          statement: 'SELECT 3',
          isFavorite: false,
          datasourceId: 'mysql-1',
        });
        expect(updated).not.toBe('forbidden');
        if (updated === 'forbidden' || updated === undefined) {
          throw new Error('expected saved query update');
        }
        expect(updated.statement).toBe('SELECT 3');
        expect(updated.isFavorite).toBe(false);
        expect(updated.datasourceId).toBe('mysql-1');

        expect(await repo.delete(accessor('alice'), fav.id)).toBe(true);
        expect(await repo.delete(accessor('alice'), fav.id)).toBe(false);
      });

      it('shared edit preserves owner isFavorite; view cannot update', async () => {
        const { repo, shares } = await openSavedQueryRepo();
        const fav = await repo.create('alice', {
          name: 'favorite',
          statement: 'SELECT 1',
          isFavorite: true,
        });
        await shares.replaceForDocument(
          'saved_query',
          fav.id,
          [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
          'alice',
        );

        expect(
          await repo.update(accessor('bob'), fav.id, {
            name: 'favorite',
            description: '',
            statement: 'SELECT 9',
            isFavorite: false,
          }),
        ).toBe('forbidden');

        await shares.replaceForDocument(
          'saved_query',
          fav.id,
          [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
          'alice',
        );
        const updated = await repo.update(accessor('bob'), fav.id, {
          name: 'favorite',
          description: '',
          statement: 'SELECT 9',
          isFavorite: false,
        });
        expect(updated).toMatchObject({
          statement: 'SELECT 9',
          isFavorite: true,
          myPermission: 'edit',
          owner: 'alice',
        });
        expect(await repo.delete(accessor('bob'), fav.id)).toBe('forbidden');
      });
    });

    describe('HistoryRepository', () => {
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

        expect(await repo.get('alice', 'h3')).toBeUndefined();

        const all = await repo.list('alice', {});
        expect(all.total).toBe(2);
        expect(all.items.map((e) => e.id)).toEqual(['h2', 'h1']);

        const failed = await repo.list('alice', { state: 'failed' });
        expect(failed.total).toBe(1);
        expect(failed.items[0]!.errorMessage).toBe('boom');

        const page = await repo.list('alice', { offset: 0, limit: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.total).toBe(2);
      });

      it('submittedAtが同じ履歴をid順で安定してページングする', async () => {
        const repo = new HistoryRepository(await open());
        for (const id of ['h_same_a', 'h_same_b']) {
          await repo.insert({
            id,
            statement: 'SELECT 1',
            state: 'finished',
            owner: 'alice',
            datasourceId: 'trino-default',
            submittedAt: '2026-01-01T00:00:00.000Z',
          });
        }

        const first = await repo.list('alice', { offset: 0, limit: 1 });
        const second = await repo.list('alice', { offset: 1, limit: 1 });

        expect(first.items.map((entry) => entry.id)).toEqual(['h_same_b']);
        expect(second.items.map((entry) => entry.id)).toEqual(['h_same_a']);
      });

      it('JSONL の期限を引き継いだ Parquet 参照を条件付きで一度だけ登録する', async () => {
        const repo = new HistoryRepository(await open());
        const expiresAt = '2026-02-01T00:00:00.000Z';
        await repo.insert({
          id: 'h_parquet',
          statement: 'SELECT 1',
          state: 'running',
          owner: 'alice',
          datasourceId: 'trino-default',
          submittedAt: '2026-01-01T00:00:00.000Z',
        });

        expect(await repo.setParquetObject('h_parquet', 'jsonl.gz', 'parquet-a', '1')).toBe(false);
        await repo.setResultObject(
          'h_parquet',
          'jsonl-a',
          expiresAt,
          { state: 'finished', rowCount: 1, elapsedMs: 2 },
          [{ name: 'id', type: 'bigint' }],
          'jsonl.zst',
        );

        expect(await repo.setParquetObject('h_parquet', 'wrong-source', 'parquet-a', '1')).toBe(
          false,
        );
        expect(await repo.setParquetObject('h_parquet', 'jsonl-a', 'parquet-a', '1')).toBe(true);
        expect(await repo.setParquetObject('h_parquet', 'jsonl-a', 'parquet-b', '1')).toBe(false);
        expect(await repo.getResultRef('alice', 'h_parquet')).toMatchObject({
          resultObjectKey: 'jsonl-a',
          resultExpiresAt: expiresAt,
          parquetRef: { objectKey: 'parquet-a', expiresAt, encodingVersion: '1' },
        });
      });

      it('Parquet 参照がない旧 JSONL 履歴を読み取り、各 artifact の期限を独立して走査する', async () => {
        const repo = new HistoryRepository(await open());
        const expiresAt = '2026-01-01T00:00:00.000Z';
        await repo.insert({
          id: 'h_old',
          statement: 'SELECT old',
          state: 'finished',
          owner: 'alice',
          datasourceId: 'trino-default',
          submittedAt: '2025-12-01T00:00:00.000Z',
        });
        await repo.setResultObject(
          'h_old',
          'jsonl-old',
          expiresAt,
          { state: 'finished', rowCount: 0, elapsedMs: 1 },
          [],
          'jsonl.gz',
        );
        expect((await repo.getResultRef('alice', 'h_old'))?.parquetRef).toBeUndefined();

        await repo.insert({
          id: 'h_dual',
          statement: 'SELECT dual',
          state: 'finished',
          owner: 'alice',
          datasourceId: 'trino-default',
          submittedAt: '2025-12-01T00:00:01.000Z',
        });
        await repo.setResultObject(
          'h_dual',
          'jsonl-dual',
          expiresAt,
          { state: 'finished', rowCount: 0, elapsedMs: 1 },
          [],
          'jsonl.gz',
        );
        expect(await repo.setParquetObject('h_dual', 'jsonl-dual', 'parquet-dual', '1')).toBe(true);

        await repo.insert({
          id: 'h_parquet_only',
          statement: 'SELECT parquet',
          state: 'finished',
          owner: 'alice',
          datasourceId: 'trino-default',
          submittedAt: '2025-12-01T00:00:02.000Z',
        });
        await repo.setResultObject(
          'h_parquet_only',
          'jsonl-only-temporary',
          expiresAt,
          { state: 'finished', rowCount: 0, elapsedMs: 1 },
          [],
          'jsonl.gz',
        );
        expect(
          await repo.setParquetObject(
            'h_parquet_only',
            'jsonl-only-temporary',
            'parquet-only',
            '1',
          ),
        ).toBe(true);
        await db.run(
          `UPDATE query_history
           SET result_object_key=NULL, result_expires_at=NULL,
               result_columns_json=NULL, result_format=NULL
           WHERE id=?`,
          ['h_parquet_only'],
        );

        expect((await repo.listExpiredResults(expiresAt)).map((item) => item.id)).toEqual([
          'h_dual',
          'h_old',
        ]);
        const firstParquet = await repo.listExpiredParquetResults(expiresAt, { limit: 1 });
        expect(firstParquet).toHaveLength(1);
        const secondParquet = await repo.listExpiredParquetResults(expiresAt, {
          after: {
            parquetExpiresAt: firstParquet[0]!.parquetExpiresAt,
            id: firstParquet[0]!.id,
          },
          limit: 10,
        });
        expect(secondParquet.map((item) => item.id)).toEqual(['h_parquet_only']);
      });

      it('JSONL と Parquet の片側削除と prune を独立して扱う', async () => {
        const repo = new HistoryRepository(await open());
        const oldSubmittedAt = '2025-12-01T00:00:00.000Z';
        const expiresAt = '2026-02-01T00:00:00.000Z';
        const insert = (id: string) =>
          repo.insert({
            id,
            statement: 'SELECT 1',
            state: 'finished',
            owner: 'alice',
            datasourceId: 'trino-default',
            submittedAt: oldSubmittedAt,
          });

        await insert('h_json_only');
        await repo.setResultObject(
          'h_json_only',
          'jsonl-only',
          expiresAt,
          { state: 'finished', rowCount: 1, elapsedMs: 1 },
          [{ name: 'id', type: 'bigint' }],
          'jsonl.zst',
        );
        await repo.setParquetObject('h_json_only', 'jsonl-only', 'parquet-only', '1');

        await insert('h_no_refs');
        await insert('h_kept_parquet');
        await repo.setResultObject(
          'h_kept_parquet',
          'jsonl-kept',
          expiresAt,
          { state: 'finished', rowCount: 1, elapsedMs: 1 },
          [],
          'jsonl.gz',
        );
        await repo.setParquetObject('h_kept_parquet', 'jsonl-kept', 'parquet-kept', '1');

        await repo.clearResultObjects(['parquet-only']);
        expect(
          await db.query(
            'SELECT result_object_key, parquet_object_key, result_format FROM query_history WHERE id=?',
            ['h_json_only'],
          ),
        ).toEqual([
          { result_object_key: 'jsonl-only', parquet_object_key: null, result_format: 'jsonl.zst' },
        ]);

        await repo.clearResultObjects(['jsonl-only']);
        expect(
          await db.query(
            'SELECT result_object_key, parquet_object_key, result_columns_json, result_format FROM query_history WHERE id=?',
            ['h_json_only'],
          ),
        ).toEqual([
          {
            result_object_key: null,
            parquet_object_key: null,
            result_columns_json: null,
            result_format: null,
          },
        ]);

        await repo.clearResultObjects(['jsonl-kept']);
        expect(
          await db.query(
            'SELECT result_object_key, parquet_object_key, result_columns_json, result_format FROM query_history WHERE id=?',
            ['h_kept_parquet'],
          ),
        ).toEqual([
          {
            result_object_key: null,
            parquet_object_key: 'parquet-kept',
            result_columns_json: null,
            result_format: null,
          },
        ]);
        expect(await repo.pruneBefore('2026-01-01T00:00:00.000Z', 10)).toBe(2);
        expect(await repo.get('alice', 'h_json_only')).toBeUndefined();
        expect(await repo.get('alice', 'h_no_refs')).toBeUndefined();
        expect(await repo.get('alice', 'h_kept_parquet')).toBeDefined();
      });
    });
  });
}

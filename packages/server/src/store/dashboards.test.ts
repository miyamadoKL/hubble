/**
 * `DashboardRepository` の CRUD と document_shares 連携を検証するテスト。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { dbBackends } from '../test/dbBackends';
import { DocumentShareRepository, type ShareAccessor } from './documentShares';
import { DashboardRepository } from './dashboards';

function accessor(user: string, groups: readonly string[] = [], role = 'member'): ShareAccessor {
  return { user, groups, role };
}

for (const backend of dbBackends) {
  describe(`DashboardRepository on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    async function openRepo(): Promise<{
      repo: DashboardRepository;
      shares: DocumentShareRepository;
    }> {
      db = await backend.open();
      const shares = new DocumentShareRepository(db);
      return { repo: new DashboardRepository(db, shares), shares };
    }

    it('creates, lists, gets, updates, searches, deletes; owner-scoped', async () => {
      const { repo } = await openRepo();

      const created = await repo.create('alice', {
        name: 'Ops board',
        description: 'daily metrics',
        widgets: [
          {
            id: 'w1',
            kind: 'text',
            position: { col: 0, row: 0, sizeX: 4, sizeY: 2 },
            text: '# Hello',
          },
        ],
      });
      expect(created.id).toMatch(/^dsh_/);
      expect(created.widgets).toHaveLength(1);

      expect(await repo.list(accessor('bob'))).toEqual([]);
      expect(await repo.get(accessor('bob'), created.id)).toBeUndefined();

      const list = await repo.list(accessor('alice'));
      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe('Ops board');
      expect(list[0]!.widgetCount).toBe(1);
      expect(list[0]!.myPermission).toBe('owner');

      const got = await repo.get(accessor('alice'), created.id);
      expect(got?.name).toBe('Ops board');
      expect(got?.widgets[0]!.kind).toBe('text');

      const updated = await repo.update(accessor('alice'), created.id, {
        name: 'Renamed board',
        description: 'updated',
        widgets: [
          {
            id: 'w2',
            kind: 'query',
            position: { col: 0, row: 0, sizeX: 6, sizeY: 4 },
            savedQueryId: 'sq_1',
            viz: 'table',
          },
        ],
      });
      expect(updated).not.toBe('forbidden');
      if (updated === 'forbidden' || updated === undefined) {
        throw new Error('expected dashboard update');
      }
      expect(updated.name).toBe('Renamed board');
      expect(updated.widgets[0]!.kind).toBe('query');

      expect(await repo.list(accessor('alice'), 'Renam')).toHaveLength(1);
      expect(await repo.list(accessor('alice'), 'zzz')).toHaveLength(0);

      expect(await repo.delete(accessor('bob'), created.id)).toBe(false);
      expect(await repo.delete(accessor('alice'), created.id)).toBe(true);
      expect(await repo.get(accessor('alice'), created.id)).toBeUndefined();
    });

    it('supports shared view/edit access and owner-only delete', async () => {
      const { repo, shares } = await openRepo();
      const created = await repo.create('alice', { name: 'Shared dash', description: 'd' });
      await shares.replaceForDocument(
        'dashboard',
        created.id,
        [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
        'alice',
      );

      const bobList = await repo.list(accessor('bob'));
      expect(bobList).toHaveLength(1);
      expect(bobList[0]!.myPermission).toBe('view');

      expect(
        await repo.update(accessor('bob'), created.id, {
          name: 'Nope',
          description: '',
          widgets: [],
        }),
      ).toBe('forbidden');

      await shares.replaceForDocument(
        'dashboard',
        created.id,
        [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
        'alice',
      );
      const edited = await repo.update(accessor('bob'), created.id, {
        name: 'Edited by bob',
        description: '',
        widgets: [],
      });
      expect(edited).not.toBe('forbidden');
      expect((edited as { name: string }).name).toBe('Edited by bob');

      expect(await repo.delete(accessor('bob'), created.id)).toBe('forbidden');
      expect(await repo.delete(accessor('alice'), created.id)).toBe(true);
    });

    it('getByIdUnscoped returns dashboard without access meta', async () => {
      const { repo } = await openRepo();
      const created = await repo.create('alice', { name: 'Unscoped', description: '' });
      const unscoped = await repo.getByIdUnscoped(created.id);
      expect(unscoped?.name).toBe('Unscoped');
      expect(unscoped?.owner).toBeUndefined();
    });
  });
}

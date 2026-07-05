/**
 * `DocumentShareRepository` の共有エントリ CRUD と accessor 向け permission
 * 解決を dbBackends（SQLite / PostgreSQL）で検証するテスト。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { dbBackends } from '../test/dbBackends';
import { DocumentShareRepository, type ShareAccessor } from './documentShares';

function accessor(user: string, groups: readonly string[] = [], role = 'member'): ShareAccessor {
  return { user, groups, role };
}

for (const backend of dbBackends) {
  describe(`DocumentShareRepository on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    async function openRepo(): Promise<DocumentShareRepository> {
      db = await backend.open();
      return new DocumentShareRepository(db);
    }

    it('replaces shares for a document and lists them', async () => {
      const repo = await openRepo();
      const listed = await repo.replaceForDocument(
        'saved_query',
        'sq_1',
        [
          { subjectType: 'user', subjectValue: 'bob', permission: 'view' },
          { subjectType: 'role', subjectValue: 'analyst', permission: 'edit' },
        ],
        'alice',
      );
      expect(listed).toHaveLength(2);
      expect(listed.map((share) => share.subjectType).sort()).toEqual(['role', 'user']);
      expect(listed.find((share) => share.subjectType === 'role')?.permission).toBe('edit');

      const replaced = await repo.replaceForDocument(
        'saved_query',
        'sq_1',
        [{ subjectType: 'user', subjectValue: 'carol', permission: 'edit' }],
        'alice',
      );
      expect(replaced).toHaveLength(1);
      expect(replaced[0]!.subjectValue).toBe('carol');
    });

    it('resolves user, group, and role matches with case-insensitive group/role', async () => {
      const repo = await openRepo();
      await repo.replaceForDocument(
        'notebook',
        'nb_1',
        [
          { subjectType: 'user', subjectValue: 'bob', permission: 'view' },
          { subjectType: 'group', subjectValue: 'Engineers@Corp.com', permission: 'edit' },
          { subjectType: 'role', subjectValue: 'ANALYST', permission: 'view' },
        ],
        'alice',
      );

      expect(await repo.resolvePermission('notebook', 'nb_1', accessor('bob'))).toBe('view');
      expect(
        await repo.resolvePermission('notebook', 'nb_1', accessor('carol', ['engineers@corp.com'])),
      ).toBe('edit');
      expect(
        await repo.resolvePermission('notebook', 'nb_1', accessor('dave', [], 'analyst')),
      ).toBe('view');
      expect(await repo.resolvePermission('notebook', 'nb_1', accessor('eve'))).toBeUndefined();
    });

    it('prefers edit over view when multiple shares match', async () => {
      const repo = await openRepo();
      await repo.replaceForDocument(
        'saved_query',
        'sq_2',
        [
          { subjectType: 'user', subjectValue: 'bob', permission: 'view' },
          { subjectType: 'role', subjectValue: 'member', permission: 'edit' },
        ],
        'alice',
      );
      expect(
        await repo.resolvePermission('saved_query', 'sq_2', accessor('bob', [], 'member')),
      ).toBe('edit');
    });

    it('lists accessible document ids for an accessor', async () => {
      const repo = await openRepo();
      await repo.replaceForDocument(
        'saved_query',
        'sq_a',
        [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
        'alice',
      );
      await repo.replaceForDocument(
        'saved_query',
        'sq_b',
        [{ subjectType: 'group', subjectValue: 'team-a', permission: 'edit' }],
        'alice',
      );
      await repo.replaceForDocument(
        'notebook',
        'nb_a',
        [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
        'alice',
      );

      const saved = await repo.listAccessibleDocumentIds(
        'saved_query',
        accessor('bob', ['TEAM-A']),
      );
      expect(saved.get('sq_a')).toBe('view');
      expect(saved.get('sq_b')).toBe('edit');
      expect(saved.has('nb_a')).toBe(false);

      const notebooks = await repo.listAccessibleDocumentIds('notebook', accessor('bob'));
      expect(notebooks.get('nb_a')).toBe('edit');
    });

    it('evaluates user and role when groups are empty', async () => {
      const repo = await openRepo();
      await repo.replaceForDocument(
        'saved_query',
        'sq_role',
        [{ subjectType: 'role', subjectValue: 'member', permission: 'view' }],
        'alice',
      );
      const map = await repo.listAccessibleDocumentIds('saved_query', accessor('bob', []));
      expect(map.get('sq_role')).toBe('view');
    });

    it('deleteForDocument removes all shares for the document', async () => {
      const repo = await openRepo();
      await repo.replaceForDocument(
        'notebook',
        'nb_del',
        [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
        'alice',
      );
      await repo.deleteForDocument('notebook', 'nb_del');
      expect(await repo.listForDocument('notebook', 'nb_del')).toEqual([]);
      expect(await repo.resolvePermission('notebook', 'nb_del', accessor('bob'))).toBeUndefined();
    });
  });
}

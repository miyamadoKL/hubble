// 利用者 state を持つ全 store が principal namespace を使うことを検証する。
import { beforeEach, expect, test } from 'vitest';
import {
  __resetPrincipalStorageForTest,
  activatePrincipalStorage,
  principalStorageKey,
} from './principalStorage';

beforeEach(() => {
  __resetPrincipalStorageForTest();
  localStorage.clear();
});

test('workspace、draft、context、datasource、UIを同じprincipalへ束縛する', async () => {
  activatePrincipalStorage('alice@example.com', 'a'.repeat(64), 'proxy');
  const [{ useNotebookStore }, { recordRecentContext }, { useDatasourceStore }, { useUiStore }] =
    await Promise.all([
      import('../notebook/notebookStore'),
      import('../notebook/recentContexts'),
      import('../stores/datasourceStore'),
      import('../stores/uiStore'),
    ]);

  const draftId = useNotebookStore.getState().createBlankNotebook();
  recordRecentContext({ datasourceId: 'warehouse', catalog: 'sales', schema: 'private' });
  useDatasourceStore.getState().setSelectedId('warehouse');
  useUiStore.getState().setTheme('dark');

  expect(localStorage.getItem(principalStorageKey('hubble-workspace'))).toContain(draftId);
  expect(localStorage.getItem(`${principalStorageKey('hubble-draft')}:${draftId}`)).not.toBeNull();
  expect(localStorage.getItem(principalStorageKey('hubble-recent-contexts'))).toContain('private');
  expect(localStorage.getItem(principalStorageKey('hubble-datasource'))).toContain('warehouse');
  expect(localStorage.getItem(principalStorageKey('hubble-ui'))).toContain('dark');

  expect(localStorage.getItem('hubble-workspace')).toBeNull();
  expect(localStorage.getItem(`hubble-draft:${draftId}`)).toBeNull();
  expect(localStorage.getItem('hubble-recent-contexts')).toBeNull();
  expect(localStorage.getItem('hubble-datasource')).toBeNull();
  expect(localStorage.getItem('hubble-ui')).toBeNull();
});

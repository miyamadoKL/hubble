import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SavedQueryResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { useDatasourceStore } from '../../stores/datasourceStore';
import { useUiStore } from '../../stores/uiStore';
import { SavedQueriesPanel } from './SavedQueriesPanel';

const notebookActions = vi.hoisted(() => ({
  insertAtActiveCursor: vi.fn(),
  addSqlCellWithSource: vi.fn(() => 'saved-query-cell'),
}));

vi.mock('../../notebook', () => notebookActions);

vi.mock('../../api/savedQueries', () => ({
  listSavedQueries: vi.fn(),
  updateSavedQuery: vi.fn(),
  deleteSavedQuery: vi.fn(),
  listSavedQueryShares: vi.fn(),
  updateSavedQueryShares: vi.fn(),
}));

vi.mock('../../hooks/useDatasources', () => ({
  resolveDatasourceLabel: (_datasources: unknown[], id: string) => id,
  useDatasources: () => ({
    datasources: [
      {
        id: 'warehouse-a',
        kind: 'trino',
        displayName: 'Warehouse A',
        capabilities: { costEstimate: true, catalogs: true },
      },
      {
        id: 'warehouse-b',
        kind: 'trino',
        displayName: 'Warehouse B',
        capabilities: { costEstimate: true, catalogs: true },
      },
    ],
  }),
}));

import { listSavedQueries } from '../../api/savedQueries';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

const ownedQuery: SavedQueryResponse = {
  id: 'sq-owned',
  name: 'Owned query',
  description: '',
  statement: 'SELECT 1',
  catalog: '',
  schema: '',
  datasourceId: undefined,
  isFavorite: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  owner: 'admin',
  myPermission: 'owner',
};

const sharedQuery: SavedQueryResponse = {
  ...ownedQuery,
  id: 'sq-shared',
  name: 'Shared query',
  owner: 'alice',
  myPermission: 'view',
};

const contextualQuery: SavedQueryResponse = {
  ...ownedQuery,
  id: 'sq-context',
  name: 'Warehouse B orders',
  statement: 'SELECT * FROM orders',
  datasourceId: 'warehouse-b',
  catalog: 'sales_b',
  schema: 'production_b',
};

function renderPanel(search = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SavedQueriesPanel search={search} />
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

describe('SavedQueriesPanel sharing UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(listSavedQueries).mockResolvedValue([ownedQuery, sharedQuery]);
    useDatasourceStore.setState({
      selectedId: 'warehouse-a',
      executionContext: {
        datasourceId: 'warehouse-a',
        catalog: 'sales_a',
        schema: 'production_a',
      },
    });
    useUiStore.setState({
      shellContext: {
        datasourceId: 'warehouse-a',
        catalog: 'sales_a',
        schema: 'production_a',
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  test('shows share badge for shared rows and hides owner-only controls', async () => {
    ({ container, root } = renderPanel());
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Shared query');
    });

    expect(container.textContent).toContain('shared by alice');
    expect(container.textContent).toContain('Can view');

    const sharedRow = [...container.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Shared query'),
    );
    expect(sharedRow).toBeTruthy();
    expect(sharedRow?.querySelector('[aria-label="Favorite"]')).toBeNull();
    expect(sharedRow?.textContent).not.toContain('Delete');

    const ownedRow = [...container.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Owned query'),
    );
    expect(ownedRow?.querySelector('[aria-label="Favorite"]')).not.toBeNull();
  });

  test('shows Share button when an owned row is expanded', async () => {
    ({ container, root } = renderPanel());
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Owned query');
    });

    const ownedToggle = [...container.querySelectorAll('button')].find(
      (btn) =>
        btn.textContent?.includes('Owned query') && btn.getAttribute('aria-expanded') === 'false',
    );
    expect(ownedToggle).toBeTruthy();
    await act(async () => {
      ownedToggle!.click();
    });

    expect(container.textContent).toContain('Share');
  });

  test('同名tableのSaved Queryを保存時のdatasource/catalog/schemaへ切り替える', async () => {
    vi.mocked(listSavedQueries).mockResolvedValue([contextualQuery]);
    ({ container, root } = renderPanel());
    await vi.waitFor(() => expect(container.textContent).toContain('Warehouse B orders'));
    const toggle = container.querySelector('button[aria-expanded="false"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const newCell = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'New cell',
    );
    expect(newCell).toBeDefined();
    await act(async () => newCell!.click());

    const expected = {
      datasourceId: 'warehouse-b',
      catalog: 'sales_b',
      schema: 'production_b',
    };
    expect(useDatasourceStore.getState().executionContext).toEqual(expected);
    expect(useUiStore.getState().shellContext).toEqual(expected);
    expect(notebookActions.addSqlCellWithSource).toHaveBeenCalledWith('SELECT * FROM orders');
  });
});

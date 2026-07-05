import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SavedQuery } from '@hubble/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SavedQueriesPanel } from './SavedQueriesPanel';

vi.mock('../../api/savedQueries', () => ({
  listSavedQueries: vi.fn(),
  updateSavedQuery: vi.fn(),
  deleteSavedQuery: vi.fn(),
  listSavedQueryShares: vi.fn(),
  updateSavedQueryShares: vi.fn(),
}));

vi.mock('../../hooks/useDatasources', () => ({
  useDatasources: () => ({ datasources: [] }),
}));

import { listSavedQueries } from '../../api/savedQueries';

const ownedQuery: SavedQuery = {
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
  myPermission: 'owner',
};

const sharedQuery: SavedQuery = {
  ...ownedQuery,
  id: 'sq-shared',
  name: 'Shared query',
  owner: 'alice',
  myPermission: 'view',
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
});

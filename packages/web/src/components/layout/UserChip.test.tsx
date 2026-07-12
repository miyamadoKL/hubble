import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@hubble/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useMe } from '../../hooks/useMe';

vi.mock('../../hooks/useMe', () => ({
  useMe: vi.fn(),
}));

import { UserChip } from './UserChip';

// UserChip は GitHub 連携状態のクエリを使うため、テストでは QueryClientProvider で
// ラップする (リトライ無効、fetch は失敗してよい: 失敗時はセクション非表示になるだけ)。
function renderChip(root: Root) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <UserChip />
      </QueryClientProvider>,
    );
  });
}

const proxyMe: MeResponse = {
  user: 'alice',
  email: 'alice@example.com',
  authMode: 'proxy',
  storageScope: 'a'.repeat(64),
  role: 'analyst',
  permissions: ['query.write'],
  datasources: [
    {
      id: 'trino-default',
      kind: 'trino',
      displayName: 'Trino',
      capabilities: { costEstimate: true, catalogs: true },
    },
  ],
};

function setMe(me: MeResponse | undefined) {
  vi.mocked(useMe).mockReturnValue({ data: me } as ReturnType<typeof useMe>);
}

describe('UserChip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  test('hides the chip in authMode none', () => {
    setMe({ ...proxyMe, authMode: 'none' });

    renderChip(root);

    expect(container.querySelector('[data-testid="user-chip"]')).toBeNull();
  });

  test('shows the chip in proxy auth mode', () => {
    setMe(proxyMe);

    renderChip(root);

    expect(container.querySelector('[data-testid="user-chip"]')).not.toBeNull();
  });
});

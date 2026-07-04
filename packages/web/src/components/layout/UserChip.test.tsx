import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MeResponse } from '@hubble/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useMe } from '../../hooks/useMe';

vi.mock('../../hooks/useMe', () => ({
  useMe: vi.fn(),
}));

import { UserChip } from './UserChip';

const proxyMe: MeResponse = {
  user: 'alice',
  email: 'alice@example.com',
  authMode: 'proxy',
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

    act(() => {
      root.render(<UserChip />);
    });

    expect(container.querySelector('[data-testid="user-chip"]')).toBeNull();
  });

  test('shows the chip in proxy auth mode', () => {
    setMe(proxyMe);

    act(() => {
      root.render(<UserChip />);
    });

    expect(container.querySelector('[data-testid="user-chip"]')).not.toBeNull();
  });
});

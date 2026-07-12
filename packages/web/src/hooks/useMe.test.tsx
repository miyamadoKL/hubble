// fresh cache 中の SSO identity 切替を focus 復帰で再検証することを確認する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, fetchMe: vi.fn() };
});

import { fetchMe } from '../api/client';
import { useMe } from './useMe';

function me(user: string, scope: string): MeResponse {
  return {
    user,
    email: user,
    authMode: 'proxy',
    storageScope: scope,
    role: 'member',
    permissions: [],
    datasources: [],
  };
}

function IdentityProbe() {
  const query = useMe();
  return <span>{query.data?.user ?? 'loading'}</span>;
}

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

describe('useMe identity refresh', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    focusManager.setFocused(true);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    focusManager.setFocused(undefined);
    container.remove();
  });

  test('staleTime内でもfocus復帰時にprincipalを再取得する', async () => {
    vi.mocked(fetchMe)
      .mockResolvedValueOnce(me('alice@example.com', 'a'.repeat(64)))
      .mockResolvedValueOnce(me('bob@example.com', 'b'.repeat(64)));

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IdentityProbe />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain('alice@example.com'));

    focusManager.setFocused(false);
    act(() => {
      focusManager.setFocused(true);
    });
    await vi.waitFor(() => expect(container.textContent).toContain('bob@example.com'));

    expect(fetchMe).toHaveBeenCalledTimes(2);
  });
});

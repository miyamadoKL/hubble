// 認証主体が確定するまで利用者 state を描画しないことを検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MeResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetPrincipalStorageForTest } from '../../storage/principalStorage';
import { AuthGate } from './AuthGate';

const mockedMe = vi.hoisted(() => ({
  data: undefined as MeResponse | undefined,
  error: null as unknown,
  refetch: vi.fn(),
}));

vi.mock('../../hooks/useMe', () => ({
  useMe: () => mockedMe,
  isUnauthenticated: () => false,
}));

function me(user: string): MeResponse {
  return {
    user,
    email: user,
    authMode: 'proxy',
    storageScope: user.startsWith('alice') ? 'a'.repeat(64) : 'b'.repeat(64),
    role: 'member',
    permissions: [],
    datasources: [],
  };
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

describe('AuthGate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    __resetPrincipalStorageForTest();
    localStorage.clear();
    mockedMe.data = undefined;
    mockedMe.error = null;
    mockedMe.refetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('認証応答前は子要素を描画しない', () => {
    act(() => {
      root.render(
        <AuthGate>
          <div>previous user workspace</div>
        </AuthGate>,
      );
    });

    expect(container.textContent).toContain('Verifying identity');
    expect(container.textContent).not.toContain('previous user workspace');
  });

  test('principal確定後だけ描画し、identity変更時は即座に隠してreloadする', async () => {
    const reload = vi.fn();
    mockedMe.data = me('alice@example.com');
    await act(async () => {
      root.render(
        <AuthGate onIdentityChange={reload}>
          <div>Alice workspace</div>
        </AuthGate>,
      );
    });
    expect(container.textContent).toContain('Alice workspace');

    mockedMe.data = me('bob@example.com');
    await act(async () => {
      root.render(
        <AuthGate onIdentityChange={reload}>
          <div>Alice workspace</div>
        </AuthGate>,
      );
    });

    expect(container.textContent).not.toContain('Alice workspace');
    expect(container.textContent).toContain('Verifying identity');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('proxy modeでは所有者不明の旧workspaceを表示せず原位置に保全する', async () => {
    localStorage.setItem('hubble-workspace', '{"openIds":["legacy-draft"]}');
    mockedMe.data = me('alice@example.com');
    await act(async () => {
      root.render(
        <AuthGate>
          <div>Alice workspace</div>
        </AuthGate>,
      );
    });

    expect(container.textContent).toContain('Previous browser data was not loaded');
    expect(container.textContent).not.toContain('Alice workspace');
    expect(localStorage.getItem('hubble-workspace')).not.toBeNull();

    const continueButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Continue with this account'),
    );
    expect(continueButton).toBeDefined();
    act(() => continueButton!.click());
    expect(container.textContent).toContain('Alice workspace');
    expect(localStorage.getItem('hubble-workspace')).not.toBeNull();
  });

  test('none modeの旧draft移行失敗時はworkspaceを開かず再読み込みを促す', async () => {
    localStorage.setItem('hubble-workspace', '{"openIds":["legacy-draft"]}');
    localStorage.setItem('hubble-draft:legacy-draft', 'SELECT legacy');
    const failedTarget = `hubble-draft:${'b'.repeat(64)}:legacy-draft`;
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === failedTarget) throw new DOMException('quota exceeded', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    });
    mockedMe.data = { ...me('technical-user'), authMode: 'none', email: undefined };

    try {
      await act(async () => {
        root.render(
          <AuthGate>
            <div>Technical workspace</div>
          </AuthGate>,
        );
      });
    } finally {
      setItem.mockRestore();
    }

    expect(container.textContent).toContain('Previous browser data could not be migrated');
    expect(container.textContent).not.toContain('Technical workspace');
    expect(localStorage.getItem('hubble-workspace')).toContain('legacy-draft');
    expect(localStorage.getItem('hubble-draft:legacy-draft')).toBe('SELECT legacy');
  });
});

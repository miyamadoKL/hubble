// 認証主体が確定するまで利用者 state を描画しないことを検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MeResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetPrincipalStorageForTest } from '../../storage/principalStorage';
import { LocaleProvider, useLocale } from '../../i18n/locale';
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

  test('本番順序（LocaleProvider 初期化 → principal storage 有効化）でも保存済みロケールが復元される', async () => {
    // MODE=test の間は principalStorageKey() が unscoped key（scope なしの base
    // そのもの）へフォールバックし、有効化前後で同じキーを読んでしまうため、
    // 「有効化前は保存値を読めない」という本番の順序問題を検出できない
    // （レビュー指摘）。production 相当の MODE に切り替え、principalStorageKey()
    // が有効化前は必ず例外を投げる本番の挙動を再現する。
    vi.stubEnv('MODE', 'production');
    try {
      const scope = 'c'.repeat(64);
      // navigator.language を en 系にしておくことで、有効化前の
      // detectInitialLocale() のフォールバック結果（'en'）と、保存済みロケール
      // （'ja'）が確実に異なる値になるようにする（復元されたかどうかを判別可能にする）。
      Object.defineProperty(window.navigator, 'language', {
        value: 'en-US',
        configurable: true,
      });
      // 有効化後に principalStorageKey() が返す scope 付きキーへ、あらかじめ
      // 'ja' を保存しておく（前回セッションでユーザーが日本語を選んでいた想定）。
      window.localStorage.setItem(`hubble-locale:${scope}`, 'ja');

      function LocaleProbe() {
        const { locale } = useLocale();
        return <span data-testid="locale-probe">{locale}</span>;
      }

      const carol: MeResponse = {
        user: 'carol',
        email: 'carol@example.com',
        authMode: 'proxy',
        storageScope: scope,
        role: 'member',
        permissions: [],
        datasources: [],
      };
      mockedMe.data = carol;

      // LocaleProvider を AuthGate の外側にマウントする（App.tsx と同じ配線順序）。
      // Provider の初期化は principal storage 有効化前に走るため、対策前は
      // ここで 'en'（navigator.language 由来）に固定され、有効化後も復元されない。
      await act(async () => {
        root.render(
          <LocaleProvider>
            <AuthGate>
              <LocaleProbe />
            </AuthGate>
          </LocaleProvider>,
        );
      });

      // principal storage 有効化が完了し children (LocaleProbe) が描画された
      // 時点で、保存済みの 'ja' に復元されている必要がある。
      expect(container.querySelector('[data-testid="locale-probe"]')?.textContent).toBe('ja');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

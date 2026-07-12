// 認証主体ごとの browser storage namespace 分離を検証する。
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetPrincipalStorageForTest,
  activatePrincipalStorage,
  principalStorageKey,
} from './principalStorage';

const ALICE_SCOPE = 'a'.repeat(64);
const BOB_SCOPE = 'b'.repeat(64);

describe('principalStorage', () => {
  beforeEach(() => {
    __resetPrincipalStorageForTest();
    localStorage.clear();
  });

  test('serverが返した同じscopeには安定したkeyを返す', () => {
    const first = activatePrincipalStorage('alice@example.com', ALICE_SCOPE, 'proxy');
    const firstKey = principalStorageKey('hubble-workspace');
    const second = activatePrincipalStorage('alice@example.com', ALICE_SCOPE, 'proxy');

    expect(first).toEqual(second);
    expect(firstKey).toBe(`hubble-workspace:${ALICE_SCOPE}`);
    expect(firstKey).not.toContain('alice@example.com');
  });

  test('次の利用者は前利用者のworkspaceとdraftを読まない', () => {
    activatePrincipalStorage('alice@example.com', ALICE_SCOPE, 'proxy');
    const aliceWorkspace = principalStorageKey('hubble-workspace');
    const aliceDraft = `${principalStorageKey('hubble-draft')}:draft-1`;
    localStorage.setItem(aliceWorkspace, JSON.stringify({ openIds: ['draft-1'] }));
    localStorage.setItem(aliceDraft, 'SELECT secret_from_alice');

    // page reload 後に別の認証主体が確定した状態を再現する。
    __resetPrincipalStorageForTest();
    activatePrincipalStorage('bob@example.com', BOB_SCOPE, 'proxy');
    const bobWorkspace = principalStorageKey('hubble-workspace');
    const bobDraft = `${principalStorageKey('hubble-draft')}:draft-1`;

    expect(bobWorkspace).not.toBe(aliceWorkspace);
    expect(bobDraft).not.toBe(aliceDraft);
    expect(localStorage.getItem(bobWorkspace)).toBeNull();
    expect(localStorage.getItem(bobDraft)).toBeNull();
    expect(localStorage.getItem(aliceDraft)).toBe('SELECT secret_from_alice');
  });

  test('auth noneでは旧workspaceとdraftを唯一のprincipalへ移行する', () => {
    localStorage.setItem('hubble-workspace', '{"openIds":["draft-1"]}');
    localStorage.setItem('hubble-draft:draft-1', 'SELECT legacy');

    expect(activatePrincipalStorage('technical-user', ALICE_SCOPE, 'none')).toMatchObject({
      kind: 'ready',
      legacyData: 'migrated',
    });
    expect(localStorage.getItem(principalStorageKey('hubble-workspace'))).toContain('draft-1');
    expect(localStorage.getItem(`${principalStorageKey('hubble-draft')}:draft-1`)).toBe(
      'SELECT legacy',
    );
    expect(localStorage.getItem('hubble-workspace')).toBeNull();
    expect(localStorage.getItem('hubble-draft:draft-1')).toBeNull();
  });

  test('auth noneのdraft移行失敗時は全sourceを維持して新規targetを戻す', () => {
    localStorage.setItem('hubble-workspace', '{"openIds":["draft-1"]}');
    localStorage.setItem('hubble-draft:draft-1', 'SELECT legacy');
    const workspaceTarget = `hubble-workspace:${ALICE_SCOPE}`;
    const draftTarget = `hubble-draft:${ALICE_SCOPE}:draft-1`;
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === draftTarget) throw new DOMException('quota exceeded', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    });

    try {
      expect(activatePrincipalStorage('technical-user', ALICE_SCOPE, 'none')).toMatchObject({
        kind: 'ready',
        legacyData: 'migration-failed',
      });
    } finally {
      setItem.mockRestore();
    }

    expect(localStorage.getItem('hubble-workspace')).toContain('draft-1');
    expect(localStorage.getItem('hubble-draft:draft-1')).toBe('SELECT legacy');
    expect(localStorage.getItem(workspaceTarget)).toBeNull();
    expect(localStorage.getItem(draftTarget)).toBeNull();
  });

  test('auth proxyでは所有者不明の旧dataを原位置に保全する', () => {
    localStorage.setItem('hubble-workspace', '{"openIds":["draft-1"]}');
    localStorage.setItem('hubble-draft:draft-1', 'SELECT legacy');

    expect(activatePrincipalStorage('alice@example.com', ALICE_SCOPE, 'proxy')).toMatchObject({
      kind: 'ready',
      legacyData: 'preserved',
    });
    expect(localStorage.getItem(principalStorageKey('hubble-workspace'))).toBeNull();
    expect(localStorage.getItem('hubble-workspace')).not.toBeNull();
    expect(localStorage.getItem('hubble-draft:draft-1')).toBe('SELECT legacy');
  });

  test('同じpage lifetimeでprincipalが変わった場合はreloadを要求する', () => {
    activatePrincipalStorage('alice@example.com', ALICE_SCOPE, 'proxy');

    expect(activatePrincipalStorage('bob@example.com', BOB_SCOPE, 'proxy')).toEqual({
      kind: 'identity-changed',
    });
    expect(principalStorageKey('hubble-workspace')).toBe(`hubble-workspace:${ALICE_SCOPE}`);
  });
});

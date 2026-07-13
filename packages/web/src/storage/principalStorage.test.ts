// 認証主体ごとの browser storage namespace 分離を検証する。
import { beforeEach, describe, expect, test } from 'vitest';
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

  test('同じpage lifetimeでprincipalが変わった場合はreloadを要求する', () => {
    activatePrincipalStorage('alice@example.com', ALICE_SCOPE, 'proxy');

    expect(activatePrincipalStorage('bob@example.com', BOB_SCOPE, 'proxy')).toEqual({
      kind: 'identity-changed',
    });
    expect(principalStorageKey('hubble-workspace')).toBe(`hubble-workspace:${ALICE_SCOPE}`);
  });
});

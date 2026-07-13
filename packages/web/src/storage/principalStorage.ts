/**
 * 認証主体ごとの browser storage namespace を管理する。
 *
 * `/api/me` で主体が確定する前に永続状態を読むことを防ぎ、同じ browser profile を
 * 複数利用者が順番に使っても workspace や UI 状態が混ざらないようにする。
 */
import type { AuthMode } from '@hubble/contracts';

interface ActivePrincipalStorage {
  principal: string;
  scope: string;
  authMode: AuthMode;
}

/** 認証主体を有効化した結果。 */
export type PrincipalStorageActivation =
  | { kind: 'ready'; scope: string }
  | { kind: 'identity-changed' };

let activePrincipalStorage: ActivePrincipalStorage | null = null;

/**
 * `/api/me` が返した opaque scope で認証済み principal を有効化する。
 *
 * 同じ page lifetime 中に主体が変わった場合は、旧 store が旧 namespace を保持して
 * いるため、その場で切り替えず page reload を要求する結果を返す。
 */
export function activatePrincipalStorage(
  principal: string,
  scope: string,
  authMode: AuthMode,
): PrincipalStorageActivation {
  if (!/^[0-9a-f]{64}$/.test(scope)) throw new Error('Invalid principal storage scope');
  if (activePrincipalStorage) {
    const sameIdentity =
      activePrincipalStorage.principal === principal &&
      activePrincipalStorage.scope === scope &&
      activePrincipalStorage.authMode === authMode;
    return sameIdentity
      ? { kind: 'ready', scope: activePrincipalStorage.scope }
      : { kind: 'identity-changed' };
  }

  activePrincipalStorage = { principal, scope, authMode };
  return { kind: 'ready', scope };
}

/** 現在の principal namespace を付けた localStorage key を返す。 */
export function principalStorageKey(base: string): string {
  if (activePrincipalStorage) return `${base}:${activePrincipalStorage.scope}`;
  // 単体テストは AuthGate を mount せず store を直接 import する。
  // 本番 build でこの経路に到達した場合は、認証前の unscoped data を読ませず停止する。
  if (import.meta.env.MODE === 'test') return base;
  throw new Error('Principal storage was accessed before authentication completed');
}

/** テスト間で module-level principal を初期化する。 */
export function __resetPrincipalStorageForTest(): void {
  activePrincipalStorage = null;
}

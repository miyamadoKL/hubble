/**
 * 認証主体ごとの browser storage namespace を管理する。
 *
 * `/api/me` で主体が確定する前に永続状態を読むことを防ぎ、同じ browser profile を
 * 複数利用者が順番に使っても workspace や UI 状態が混ざらないようにする。
 */
import type { AuthMode } from '@hubble/contracts';

/** 旧 unscoped data の処理結果。 */
export type LegacyBrowserData = 'none' | 'migrated' | 'preserved' | 'migration-failed';

interface ActivePrincipalStorage {
  principal: string;
  scope: string;
  authMode: AuthMode;
  legacyData: LegacyBrowserData;
}

/** 認証主体を有効化した結果。 */
export type PrincipalStorageActivation =
  | { kind: 'ready'; scope: string; legacyData: LegacyBrowserData }
  | { kind: 'identity-changed' };

const LEGACY_SINGLE_KEYS = [
  'hubble-workspace',
  'hubble-workspace-backup',
  'hubble-recent-contexts',
  'hubble-datasource',
  'hubble-ui',
] as const;
const LEGACY_DRAFT_PREFIX = 'hubble-draft:';
const SCOPED_DRAFT_PATTERN = /^hubble-draft:[0-9a-f]{64}:/;
const LEGACY_NOTICE_KEY = 'hubble-legacy-data-notice';

let activePrincipalStorage: ActivePrincipalStorage | null = null;

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 他 principal の scoped draft を除外して旧 draft key だけを列挙する。 */
function legacyDraftKeys(storage: Storage): string[] | null {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_DRAFT_PREFIX) && !SCOPED_DRAFT_PATTERN.test(key)) keys.push(key);
    }
  } catch {
    return null;
  }
  return keys;
}

/** 所有者を特定できない旧 browser data が残っているかを返す。 */
function hasLegacyBrowserData(storage: Storage): boolean {
  try {
    const drafts = legacyDraftKeys(storage);
    return (
      LEGACY_SINGLE_KEYS.some((key) => storage.getItem(key) !== null) ||
      drafts === null ||
      drafts.length > 0
    );
  } catch {
    return true;
  }
}

interface LegacyMove {
  source: string;
  target: string;
  value: string;
}

/** auth none の単一利用者向けに旧 unscoped data の移行計画を作る。 */
function legacyMovePlan(storage: Storage): LegacyMove[] | null {
  const plan: LegacyMove[] = [];
  try {
    for (const source of LEGACY_SINGLE_KEYS) {
      const value = storage.getItem(source);
      if (value !== null) plan.push({ source, target: principalStorageKey(source), value });
    }
    const drafts = legacyDraftKeys(storage);
    if (!drafts) return null;
    for (const source of drafts) {
      const value = storage.getItem(source);
      if (value === null) continue;
      const id = source.slice(LEGACY_DRAFT_PREFIX.length);
      plan.push({ source, target: `${principalStorageKey('hubble-draft')}:${id}`, value });
    }
  } catch {
    return null;
  }
  return plan;
}

/**
 * 全 target の書き込み成功後だけ source 一式を削除する。
 * 途中失敗時は今回作った target を戻し、workspace と draft の参照関係を維持する。
 */
function migrateLegacyBrowserData(storage: Storage): LegacyBrowserData {
  const plan = legacyMovePlan(storage);
  if (!plan) return 'migration-failed';
  const createdTargets: string[] = [];
  try {
    for (const entry of plan) {
      const existing = storage.getItem(entry.target);
      if (existing !== null && existing !== entry.value) return 'preserved';
    }
    for (const entry of plan) {
      const existing = storage.getItem(entry.target);
      if (existing === null) {
        storage.setItem(entry.target, entry.value);
        if (storage.getItem(entry.target) !== entry.value) {
          throw new Error('Failed to verify migrated browser data');
        }
        createdTargets.push(entry.target);
      }
    }
  } catch {
    for (const target of createdTargets.reverse()) {
      try {
        storage.removeItem(target);
      } catch {
        // source は一件も削除していないため、rollback の残骸があっても原本は維持される。
      }
    }
    return 'migration-failed';
  }

  // 全 target が揃った後にだけ旧 source を削除する。
  for (const entry of plan) {
    try {
      storage.removeItem(entry.source);
    } catch {
      // target 一式は完成しているため、旧 source の重複だけを許容する。
    }
  }
  return 'migrated';
}

/** 認証 mode に応じて旧 data を移行または原位置保全する。 */
function handleLegacyBrowserData(authMode: AuthMode): LegacyBrowserData {
  const storage = safeLocalStorage();
  if (!storage || !hasLegacyBrowserData(storage)) return 'none';
  if (authMode === 'proxy') return 'preserved';
  return migrateLegacyBrowserData(storage);
}

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
      ? {
          kind: 'ready',
          scope: activePrincipalStorage.scope,
          legacyData: activePrincipalStorage.legacyData,
        }
      : { kind: 'identity-changed' };
  }

  activePrincipalStorage = { principal, scope, authMode, legacyData: 'none' };
  const legacyData = handleLegacyBrowserData(authMode);
  activePrincipalStorage.legacyData = legacyData;
  return { kind: 'ready', scope, legacyData };
}

/** 現在の principal namespace を付けた localStorage key を返す。 */
export function principalStorageKey(base: string): string {
  if (activePrincipalStorage) return `${base}:${activePrincipalStorage.scope}`;
  // 単体テストは AuthGate を mount せず store を直接 import する。
  // 本番 build でこの経路に到達した場合は、認証前の unscoped data を読ませず停止する。
  if (import.meta.env.MODE === 'test') return base;
  throw new Error('Principal storage was accessed before authentication completed');
}

/** 現在の principal が旧 data 保全通知を確認済みかを返す。 */
export function isLegacyDataNoticeAcknowledged(): boolean {
  try {
    return safeLocalStorage()?.getItem(principalStorageKey(LEGACY_NOTICE_KEY)) === '1';
  } catch {
    return false;
  }
}

/** 旧 data 保全通知の確認状態を現在の principal scope へ保存する。 */
export function acknowledgeLegacyDataNotice(): void {
  try {
    safeLocalStorage()?.setItem(principalStorageKey(LEGACY_NOTICE_KEY), '1');
  } catch {
    // 通知確認の永続化失敗は利用者 data の保全状態へ影響しない。
  }
}

/** テスト間で module-level principal を初期化する。 */
export function __resetPrincipalStorageForTest(): void {
  activePrincipalStorage = null;
}

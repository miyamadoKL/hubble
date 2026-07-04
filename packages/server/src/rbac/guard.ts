/**
 * ロール別 Query Guard の実効設定を解決する。
 */
import type { GuardMode, GuardOnUnknown } from '@hubble/contracts';
import type { ServerConfig } from '../config';
import type { ResolvedRole, RoleGuardOverrides } from './types';

/** 見積もり・enforce 判定に使う実効 Guard 上限。 */
export interface EffectiveGuardLimits {
  mode: GuardMode;
  maxScanBytes: number;
  maxScanRows: number;
  onUnknown: GuardOnUnknown;
}

/**
 * グローバル guard 設定に principal.role.guard を浅くマージした実効設定を返す。
 */
export function effectiveGuardLimits(
  base: ServerConfig['guard'],
  role: ResolvedRole,
): EffectiveGuardLimits {
  const overrides: RoleGuardOverrides = role.guard ?? {};
  return {
    mode: overrides.mode ?? base.mode,
    maxScanBytes: overrides.maxScanBytes ?? base.maxScanBytes,
    maxScanRows: overrides.maxScanRows ?? base.maxScanRows,
    onUnknown: overrides.onUnknown ?? base.onUnknown,
  };
}

/**
 * グローバル config.guard に principal.role.guard を浅くマージした実効設定を返す。
 */
export function effectiveGuard(config: ServerConfig, role: ResolvedRole): EffectiveGuardLimits {
  return effectiveGuardLimits(config.guard, role);
}

/** QUERY_BLOCKED の details や UI 向けに、実効 Guard 上限のスナップショットを返す。 */
export function effectiveGuardLimitsSnapshot(
  config: ServerConfig,
  role: ResolvedRole,
): EffectiveGuardLimits {
  return effectiveGuard(config, role);
}

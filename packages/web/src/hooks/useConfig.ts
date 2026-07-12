// App config (`GET /api/config`) via TanStack Query. Exposes the
// server defaults — notably `defaults.limit`, the LIMIT auto-append value used
// by the execution layer. Config is effectively static for a session, so it is
// cached aggressively.
// 現在は datasource のホットリロードを反映するため、60秒周期でも再取得する。
//
// --- ファイル概要（日本語） ---
// サーバー側のアプリ設定（GET /api/config）を TanStack Query 経由で取得し、キャッシュするフック群。
// 取得した設定には「クエリ実行時に自動付与する LIMIT のデフォルト値」（defaults.limit）や、
// 「Query Guard（危険なクエリを事前に検知し、抑制する機能）の設定」（guard）が含まれる。
// 同一周期内ではキャッシュを利用し、60秒ごとの再取得とフォーカス復帰で設定変更を反映する。
// 各フックは他のコンポーネント（クエリ実行系、ツールバー等）から呼び出され、設定値がまだ
// 取得できていない間はフォールバック値を返す。

import { useQuery } from '@tanstack/react-query';
import type { AppConfig, GuardConfig } from '@hubble/contracts';
import { fetchConfig } from '../api/client';

// TanStack Query のキャッシュキー。設定値はグローバルに1種類しかないため単一のキーで管理する。
export const configQueryKey = ['config'] as const;

/** datasource reload を前面表示中のタブへ反映する再取得周期。 */
export const CONFIG_REFRESH_MS = 60_000;

/** Fallback default LIMIT when the config request hasn't resolved yet. */
/** /api/config の取得がまだ完了していない間に使う、デフォルト LIMIT のフォールバック値。 */
export const FALLBACK_LIMIT = 5000;

/**
 * アプリ設定（AppConfig）を取得するベースとなるフック。GET /api/config を fetchConfig
 * （../api/client）経由で呼び出し、結果を TanStack Query でキャッシュする。
 * datasource の既定値がホットリロードで変わるため、有限周期とフォーカス復帰時に再取得する。
 * retry: 1 で失敗時に1回だけ再試行する。
 * 他の useDefaultLimit / useGuardConfig はこのフックの上に薄くラップされている。
 */
export function useConfig() {
  return useQuery<AppConfig>({
    queryKey: configQueryKey,
    queryFn: fetchConfig,
    staleTime: CONFIG_REFRESH_MS,
    refetchInterval: CONFIG_REFRESH_MS,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    retry: 1,
  });
}

/** The default LIMIT, falling back to {@link FALLBACK_LIMIT}. */
/**
 * クエリ実行時に自動付与されるデフォルトの LIMIT 値を返すフック。
 * 内部で useConfig を呼び出し、data.defaults.limit を参照する。
 * 設定がまだロードされていない場合（data が undefined）は {@link FALLBACK_LIMIT} を返す。
 * useGlobalShortcuts.ts の「実行」ショートカットなど、クエリ実行系のコードから利用される。
 */
export function useDefaultLimit(): number {
  const { data } = useConfig();
  return data?.defaults.limit ?? FALLBACK_LIMIT;
}

/** Guard config, defaulting to a safe `off` until /api/config resolves. */
// Query Guard がまだロードされていない間に使う、安全側（無効化）のデフォルト設定。
// mode: 'off' なので実質的にガードは何も制限しない状態になる。
const GUARD_OFF: GuardConfig = {
  mode: 'off',
  maxScanBytes: 0,
  maxScanRows: 0,
  onUnknown: 'allow',
  bytesPerSecond: 0,
};

/** The active Query Guard config (Query Guard feature). */
/**
 * 現在有効な Query Guard の設定を返すフック。Query Guard はスキャン量が大きすぎるクエリなどを
 * 事前に検知して警告し、ブロックする機能で、その挙動（mode やしきい値）をここから取得する。
 * useConfig の結果から guard フィールドを取り出し、未取得の間は GUARD_OFF
 * （安全側のデフォルト。実質無効化）を返す。useEstimate.ts が呼び出す見積もり結果と合わせて
 * SqlCell 側の警告表示ロジックに使われる。
 */
export function useGuardConfig(): GuardConfig {
  const { data } = useConfig();
  return data?.guard ?? GUARD_OFF;
}

import { z } from 'zod';
import { authModeSchema } from './auth';

/**
 * App config exposed via `GET /api/config`.
 * Built server-side from env vars and validated before being sent to the client.
 *
 * アプリ全体の設定を表す契約。server が環境変数から組み立て、この zod スキーマで
 * バリデーションしたうえで `GET /api/config` として web に配信する。
 * web はアプリ起動時にこれを取得し、Trino 接続先の表示や既定 LIMIT、
 * Query Guard の挙動などを決める。
 */
export const appDefaultsSchema = z.object({
  // 既定で選択されるカタログ名（未設定の場合は web 側でユーザーに選択させる）。
  catalog: z.string().optional(),
  // 既定で選択されるスキーマ名。
  schema: z.string().optional(),
  /** Default LIMIT auto-appended to LIMIT-less SELECT statements. */
  // LIMIT 句を持たない SELECT 文に自動付与される既定の LIMIT 値。
  limit: z.number().int().positive(),
});

// server が接続する Trino クラスタの情報。
export const trinoConfigSchema = z.object({
  // Trino coordinator の URL。
  url: z.url(),
  // Trino に対するデフォルトの実行ユーザー名（`none` 認証モード時など）。
  user: z.string().min(1),
});

/** Query Guard operating mode (Query Guard feature). */
// Query Guard の動作モード。'off'（無効） / 'warn'（警告のみ） / 'enforce'（ブロックする）。
export const guardModeSchema = z.enum(['off', 'warn', 'enforce']);
export type GuardMode = z.infer<typeof guardModeSchema>;

/** What to do when scan cost cannot be estimated. */
// スキャンコストを見積もれなかった場合の扱い。'allow'（許可） / 'warn'（警告） / 'block'（拒否）。
export const guardOnUnknownSchema = z.enum(['allow', 'warn', 'block']);
export type GuardOnUnknown = z.infer<typeof guardOnUnknownSchema>;

/**
 * Public Query Guard config exposed via `GET /api/config`. The web uses it to
 * decide whether to call `/estimate` and how to surface the verdict.
 *
 * web に公開される Query Guard の設定値。web はこれを見て見積もり API
 * (`/api/queries/estimate`) を呼ぶかどうか、結果の見せ方をどうするかを判断する。
 */
export const guardConfigSchema = z.object({
  mode: guardModeSchema,
  /** Scan-bytes limit (0 = no limit). */
  // スキャンバイト数の上限（0 は上限なしを意味する）。
  maxScanBytes: z.number().int().nonnegative(),
  /** Scan-rows limit (0 = no limit). */
  // スキャン行数の上限（0 は上限なしを意味する）。
  maxScanRows: z.number().int().nonnegative(),
  onUnknown: guardOnUnknownSchema,
  /** Cluster throughput estimate for `estimatedSeconds` (0 = no time prediction). */
  // クラスタのスループット見積もり（バイト/秒）。estimatedSeconds の算出に使う。
  // 0 は時間予測を行わないことを意味する。
  bytesPerSecond: z.number().int().nonnegative(),
});
export type GuardConfig = z.infer<typeof guardConfigSchema>;

export const appConfigSchema = z.object({
  trino: trinoConfigSchema,
  defaults: appDefaultsSchema,
  /** Active authentication mode; web hides the user chip in `none`. */
  authMode: authModeSchema,
  /** Query Guard settings (Query Guard feature). */
  guard: guardConfigSchema,
  // フロントエンドに表示するアプリバージョン文字列。
  version: z.string().min(1),
});

export type AppDefaults = z.infer<typeof appDefaultsSchema>;
export type TrinoConfig = z.infer<typeof trinoConfigSchema>;
/** `GET /api/config` レスポンス全体の推論型。 */
export type AppConfig = z.infer<typeof appConfigSchema>;

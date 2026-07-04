import { z } from 'zod';
import { permissionSchema } from './rbac';

/**
 * Authentication contract. The server runs in one of two modes:
 * `none` (no auth; principal is the configured `TRINO_USER`) or `proxy` (behind
 * oauth2-proxy; principal is resolved from trusted SSO headers).
 *
 * 認証まわりの契約を定義するファイル。
 * server は `none`（認証なし。実行ユーザーは env の `TRINO_USER` 固定）と
 * `proxy`（oauth2-proxy 配下で稼働し、信頼済み SSO ヘッダーからユーザーを解決）の
 * いずれかのモードで動作する。
 */

/**
 * 認証モードを表す列挙値スキーマ。'none' | 'proxy' のいずれか。
 */
export const authModeSchema = z.enum(['none', 'proxy']);
/** 認証モードの推論型。 */
export type AuthMode = z.infer<typeof authModeSchema>;

/**
 * `GET /api/me` response. `user` is the resolved principal
 * (owner id + Trino execution user). `email` is present only when a proxy
 * supplied it. In `none` mode the web hides the user chip.
 *
 * `GET /api/me` のレスポンススキーマ。ログイン中ユーザーの情報を web に伝える。
 */
export const meResponseSchema = z.object({
  // 解決済みの実行ユーザー名。保存データの所有者 id と Trino 実行ユーザーを兼ねる。
  user: z.string().min(1),
  // proxy モードで SSO ヘッダーから email を取得できた場合のみ設定される。
  email: z.string().optional(),
  // 現在有効な認証モード。none の場合 web は右上のユーザーチップを非表示にする。
  authMode: authModeSchema,
  // 解決済みロール名（rbac.yaml または組み込み unrestricted）。
  role: z.string().min(1),
  // ロールに紐づく権限一覧（ソート済みで返す）。
  permissions: z.array(permissionSchema),
});
/** `GET /api/me` レスポンスの推論型。 */
export type MeResponse = z.infer<typeof meResponseSchema>;

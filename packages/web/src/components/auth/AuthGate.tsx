/**
 * 認証ゲートコンポーネントを定義するモジュール。
 *
 * アプリ全体を認証状態でゲートし、未認証時には子要素の代わりに
 * 「認証が必要」画面 (AuthRequired) を表示する役割を持つ。認証の判定は
 * `/api/me` エンドポイントの結果 (useMe) に基づいて行う。
 */
import type { ReactNode } from 'react';
import { useMe, isUnauthenticated } from '../../hooks/useMe';
import { AuthRequired } from './AuthRequired';

/**
 * Gate the app on authentication. `/api/me` is the canonical
 * probe: in `proxy` mode an unauthenticated request (direct access / expired
 * session) returns 401 UNAUTHENTICATED, and we swap the whole UI for the
 * "authentication required" screen. In `none` mode `/api/me` always succeeds,
 * so the gate is transparent.
 *
 * While the probe is in flight we render the app optimistically; behind an
 * oauth2-proxy the request resolves immediately and there is no flash.
 *
 * アプリ全体を認証状態に応じて出し分けるコンポーネント。
 * `/api/me` を認証状態の正規のプローブとして扱う。`proxy` モードでは、
 * 直接アクセスやセッション期限切れなど未認証のリクエストは 401
 * UNAUTHENTICATED を返すため、その場合はアプリ全体の UI を「認証が必要」
 * 画面に差し替える。`none` モードでは `/api/me` が常に成功するため、この
 * ゲートは実質的に素通り (透過) になる。
 *
 * プローブが実行中の間はいったん楽観的に子要素 (children) をそのまま
 * 描画する。oauth2-proxy 配下ではリクエストが即座に解決するため、
 * 画面のちらつき (flash) は発生しない。
 *
 * @param children ゲートを通過した場合に描画する子要素 (アプリ本体)。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  // `/api/me` の呼び出し結果からエラー情報のみを取り出す。
  const { error } = useMe();
  // エラーが「未認証」を示す場合は、アプリ本体の代わりに認証要求画面を表示する。
  if (isUnauthenticated(error)) return <AuthRequired />;
  // 認証済み（または none モードで常に成功）の場合はそのまま子要素を描画する。
  return <>{children}</>;
}

/**
 * Hono の認証ミドルウェア本体。
 *
 * BFF（Backend For Frontend）のすべての `/api` ルートの手前で動作し、リクエストごとに
 * `Principal`（認証済みユーザー識別情報）を解決して `c.set('principal', …)` で後続の
 * ハンドラーに渡す。
 * - `none` モード: 認証を行わず、固定の技術ユーザーとして扱う（開発やシングルユーザー運用向け）。
 * - `proxy` モード: oauth2-proxy 等の信頼済みリバースプロキシが付与する SSO ヘッダーから
 *   principal.ts の {@link PrincipalResolver} を使って解決する。送信元アドレスが
 *   cidr.ts の CIDR 判定で信頼済みでない場合や、ヘッダーが欠落している場合は 401 を返す。
 *
 * 解決された principal はここから先の Trino impersonation（X-Trino-User）や
 * リソースの所有者判定（クエリやスケジュール等）の基点として使われる。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { UNAUTHENTICATED } from '@hubble/contracts';
import type { AuthConfig } from '../config';
import { AppError } from '../errors';
import { resolveRoleForPrincipal } from '../rbac/resolve';
import type { LoadedRbac } from '../rbac/types';
import { PrincipalResolver, type Principal, type PrincipalIdentity } from './principal';

/**
 * Hono `c.var` bindings set by the auth middleware.
 * 認証ミドルウェアが設定する Hono の `c.var` 型定義。ハンドラー側で `c.var.principal` として
 * 型安全に参照できるようにする。
 */
export interface AuthVariables {
  /**
   * The authenticated identity for the request.
   * リクエストの認証済み識別情報。
   */
  principal: Principal;
}

/**
 * Extract the peer's remote address. Defaults to `@hono/node-server`'s
 * connection-info helper; injectable so tests can drive the trust decision
 * without a real socket.
 *
 * リクエストの送信元（ピア）アドレスを取り出す関数の型。デフォルトは
 * `@hono/node-server` の connection-info ヘルパーを使うが、テストでは実ソケットなしに
 * 信頼判定を駆動できるよう差し替え可能にしてある。
 */
export type RemoteAddressFn = (c: Context) => string | undefined;

const defaultRemoteAddress: RemoteAddressFn = (c) => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // 接続情報が取得できない実行環境（一部のテスト用アダプタ等）では undefined を返す。
    return undefined;
  }
};

/** {@link authMiddleware} の生成オプション。 */
export interface AuthMiddlewareOptions {
  auth: AuthConfig;
  /**
   * Principal used in `none` mode (owner id + Trino user) — the technical user.
   * none モードで使う principal（所有者 id 兼 Trino ユーザー）＝技術ユーザー名。
   */
  noneModeUser: string;
  /**
   * Override the remote-address source (tests).
   * リモートアドレス取得元の差し替え（テスト用）。
   */
  remoteAddress?: RemoteAddressFn;
  /** 現在の RBAC 設定を返す getter。principal 解決直後にロールを付与する。 */
  getRbac: () => LoadedRbac;
}

function attachRole(rbac: LoadedRbac, identity: PrincipalIdentity): Principal {
  return {
    ...identity,
    role: resolveRoleForPrincipal(rbac, identity),
  };
}

/**
 * Throw the contract 401 `{ error: { code: 'UNAUTHENTICATED' } }` envelope.
 *
 * コントラクトで定義された 401 レスポンス（`UNAUTHENTICATED` エラーコード）を
 * {@link AppError} として送出する。呼び出し元の型を `never` にすることで、
 * 呼び出し側は分岐後にフォールスルーしないことを型チェッカーに伝えられる。
 * @param reason - 内部向けの失敗理由（クライアントへのメッセージにも使われる）。
 */
function unauthenticated(reason: string): never {
  throw new AppError(401, { code: UNAUTHENTICATED, message: reason });
}

/**
 * Authentication middleware. Resolves a `Principal` and exposes
 * it via `c.set('principal', …)`.
 *
 * - `none` mode: every request is authenticated as the technical user.
 * - `proxy` mode: the principal is resolved from trusted SSO headers; requests
 *   from untrusted peers or without identity headers get 401.
 *
 * `/api/healthz` and `/api/readyz` are always exempt. Static assets are served
 * outside the API and never reach this middleware (it is mounted under `/api`).
 *
 * 認証ミドルウェア。`Principal` を解決し `c.set('principal', …)` で公開する。
 * - `none` モード: すべてのリクエストを技術ユーザーとして認証済み扱いにする。
 * - `proxy` モード: 信頼済み SSO ヘッダーから principal を解決する。信頼できないピアからの
 *   リクエストや、識別ヘッダーが欠落しているリクエストは 401 になる。
 *
 * `/api/healthz` と `/api/readyz` は常に例外（このミドルウェアの対象外）。
 * 静的アセットは API の外側で配信されるため、このミドルウェア（`/api` 配下にマウント）を
 * 通過しない。
 * @param options - 認証設定、技術ユーザー名、リモートアドレス取得元（差し替え可）。
 * @returns Hono の `MiddlewareHandler`。認証失敗時は例外（401）を送出する。
 */
export function authMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler {
  const { auth, noneModeUser, getRbac } = options;
  const remoteAddress = options.remoteAddress ?? defaultRemoteAddress;
  // proxy モードのときだけ CIDR リストをパース済みの PrincipalResolver を1つ生成し、
  // リクエストごとに使い回す（毎リクエストで CIDR 文字列を再パースしない）。
  const resolver = auth.mode === 'proxy' ? new PrincipalResolver(auth) : undefined;

  return async (c, next) => {
    if (auth.mode === 'none' || resolver === undefined) {
      // none モード: 認証を行わず、常に固定の技術ユーザーとして principal を設定する。
      c.set('principal', attachRole(getRbac(), { user: noneModeUser }));
      await next();
      return;
    }
    // proxy モード: SSO ヘッダーと送信元アドレスから principal を解決する。
    const result = resolver.resolve(c.req.header(), remoteAddress(c));
    if (!result.ok) {
      // 信頼できないプロキシからのリクエスト、またはヘッダー欠落 → 401 を送出して打ち切る。
      unauthenticated(result.reason);
    }
    c.set('principal', attachRole(getRbac(), result.principal));
    await next();
  };
}

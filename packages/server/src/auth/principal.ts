/**
 * SSO ヘッダーから `Principal`（認証済みユーザー識別情報）を解決するロジック。
 *
 * proxy モードでは oauth2-proxy 等の信頼済みリバースプロキシが `X-Forwarded-User` /
 * `X-Forwarded-Email` のようなヘッダーを付与してリクエストを転送してくる。この
 * モジュールは、cidr.ts の CIDR 判定でその送信元が信頼できるプロキシであることを
 * 確認したうえで、設定された `userMapping` に従いヘッダー値から `Principal` を組み立てる。
 * 送信元が信頼できない場合や識別ヘッダーが欠落している場合は未認証として扱う。
 * middleware.ts の `authMiddleware` から利用され、解決された principal は
 * Trino への impersonation（X-Trino-User）やリソース所有者判定の基点になる。
 */
import type { AuthConfig } from '../config';
import { isTrustedAddress, parseCidrList, type ParsedCidr } from './cidr';
import type { ResolvedRole } from '../rbac/types';

/**
 * The authenticated identity for a request. `user` is both the
 * owner id for stored resources and the `X-Trino-User` impersonation value.
 *
 * リクエストの認証済み識別情報。`user` は保存リソースの所有者 id と、
 * Trino へのリクエストで使う `X-Trino-User`（impersonation）の値を兼ねる。
 */

/** SSO / none モードで解決されたユーザー識別子（ロール付与前）。 */
export interface PrincipalIdentity {
  user: string;
  email?: string;
  /** oauth2-proxy 等が付与するグループ一覧。ヘッダー欠落時は未設定（空配列として扱う）。 */
  groups?: string[];
}

export interface Principal extends PrincipalIdentity {
  /** リクエストごとに解決されたロール（Phase A は露出のみ、強制は Phase B）。 */
  role: ResolvedRole;
}

/** {@link PrincipalResolver.resolve} の結果。成功時は identity を、失敗時は理由を持つ。 */
export type ResolveResult =
  | { ok: true; principal: PrincipalIdentity }
  | { ok: false; reason: string };

/**
 * Look up a header value (case-insensitive) from a plain record.
 *
 * プレーンなレコードからヘッダー値を大文字小文字を無視して探す。
 * @param headers - ヘッダー名 -> 値 のレコード。
 * @param name - 探したいヘッダー名。
 * @returns 見つかった値。存在しなければ undefined。
 */
function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  // Hono's `c.req.header()` already returns lower-cased keys, but be defensive.
  // Hono の c.req.header() は既に小文字キーを返すが、直接呼ばれる場合に備えて防御的に扱う。
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  // 完全一致しなかった場合は全キーを走査して大文字小文字無視で照合する。
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Parse a comma-separated SSO groups header into trimmed, non-empty group names.
 *
 * カンマ区切りの SSO グループヘッダーをパースする。各要素を trim し、空要素を除去する。
 * ヘッダー自体が欠落している場合は undefined（RBAC では空配列として扱う）。
 * @param value - グループヘッダーの生文字列。
 * @returns パース済みグループ名の配列。ヘッダー欠落時は undefined。
 */
export function parseGroupsHeader(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group.length > 0);
}

/**
 * Apply the configured mapping to the SSO header values.
 *
 * 設定された `userMapping` に従い、SSO ヘッダーの値から {@link Principal} を組み立てる。
 * @param mapping - principal の組み立て方（'user' | 'email' | 'email-localpart'）。
 * @param userHeader - `X-Forwarded-User` 相当のヘッダー値。
 * @param emailHeader - `X-Forwarded-Email` 相当のヘッダー値。
 * @returns 組み立てられた {@link PrincipalIdentity}。マッピングに必要なヘッダーが欠落または空文字の場合は
 *          undefined（未認証扱い）。
 */
export function mapPrincipal(
  mapping: AuthConfig['userMapping'],
  userHeader: string | undefined,
  emailHeader: string | undefined,
): PrincipalIdentity | undefined {
  const user = userHeader?.trim() || undefined;
  const email = emailHeader?.trim() || undefined;
  switch (mapping) {
    case 'user':
      // user ヘッダーの値をそのまま principal の user とする。email は付随情報として残す。
      return user ? { user, ...(email ? { email } : {}) } : undefined;
    case 'email':
      // メールアドレス全体を user として使う。
      return email ? { user: email, email } : undefined;
    case 'email-localpart': {
      // メールアドレスの '@' より前（ローカルパート）を user として使う。
      if (!email) return undefined;
      const at = email.indexOf('@');
      const localpart = at > 0 ? email.slice(0, at) : email; // '@' がなければ値全体を使う
      if (localpart === '') return undefined;
      return { user: localpart, email };
    }
    default:
      return undefined;
  }
}

/**
 * Resolver bound to a config. Pre-parses the trusted CIDR list once. Pure given
 * (headers, remoteAddress) so it is trivially unit-testable without a socket.
 *
 * 設定に紐づいた principal リゾルバー。信頼済み CIDR リストはコンストラクタで一度だけ
 * パースしてキャッシュする。`(headers, remoteAddress)` に対して純粋関数的に振る舞うため、
 * 実ソケットなしでも容易に単体テストできる。
 */
export class PrincipalResolver {
  private readonly trusted: ParsedCidr[];

  constructor(private readonly auth: AuthConfig) {
    this.trusted = parseCidrList(auth.trustedProxyCidrs);
  }

  /**
   * True when the peer address falls inside a trusted-proxy CIDR.
   * ピアアドレスが信頼済みプロキシの CIDR に含まれていれば true。
   */
  isTrusted(remoteAddress: string | undefined): boolean {
    return isTrustedAddress(this.trusted, remoteAddress);
  }

  /**
   * Resolve a request's principal in `proxy` mode. SSO headers are honored only
   * when the peer is a trusted proxy; otherwise (untrusted peer, or missing
   * headers) the request is unauthenticated and the caller returns 401.
   *
   * proxy モードでリクエストの principal を解決する。SSO ヘッダーは、ピアが信頼済み
   * プロキシである場合にのみ信用される。それ以外（信頼できないピア、または識別ヘッダーの
   * 欠落）の場合は未認証とし、呼び出し元（middleware.ts）が 401 を返す。
   * @param headers - リクエストヘッダー（ヘッダー名 -> 値）。
   * @param remoteAddress - リクエストの送信元アドレス。
   * @returns 成功時は identity を含む結果、失敗時は理由文字列を含む結果。
   */
  resolve(
    headers: Record<string, string | undefined>,
    remoteAddress: string | undefined,
  ): ResolveResult {
    if (!this.isTrusted(remoteAddress)) {
      // 送信元が信頼済みプロキシでない場合、SSO ヘッダーの値は一切信用せず未認証とする
      // （なりすまし防止: 誰でも X-Forwarded-User を直接付けて送れてしまうため）。
      return { ok: false, reason: 'Request did not originate from a trusted proxy' };
    }
    const userHeader = header(headers, this.auth.ssoHeaderUser);
    const emailHeader = header(headers, this.auth.ssoHeaderEmail);
    const groupsHeader = header(headers, this.auth.ssoHeaderGroups);
    const principal = mapPrincipal(this.auth.userMapping, userHeader, emailHeader);
    if (!principal) {
      // 信頼済みプロキシ経由でも識別ヘッダーが無ければ principal を組み立てられない。
      return { ok: false, reason: 'No SSO identity headers present' };
    }
    const groups = parseGroupsHeader(groupsHeader);
    return {
      ok: true,
      principal: groups !== undefined ? { ...principal, groups } : principal,
    };
  }
}

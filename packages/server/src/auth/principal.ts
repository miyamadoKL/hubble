import type { AuthConfig } from '../config';
import { isTrustedAddress, parseCidrList, type ParsedCidr } from './cidr';

/**
 * The authenticated identity for a request (design.md §11). `user` is both the
 * owner id for stored resources and the `X-Trino-User` impersonation value.
 */
export interface Principal {
  user: string;
  email?: string;
}

export type ResolveResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: string };

/** Look up a header value (case-insensitive) from a plain record. */
function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  // Hono's `c.req.header()` already returns lower-cased keys, but be defensive.
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Apply the configured mapping to the SSO header values. */
export function mapPrincipal(
  mapping: AuthConfig['userMapping'],
  userHeader: string | undefined,
  emailHeader: string | undefined,
): Principal | undefined {
  const user = userHeader?.trim() || undefined;
  const email = emailHeader?.trim() || undefined;
  switch (mapping) {
    case 'user':
      return user ? { user, ...(email ? { email } : {}) } : undefined;
    case 'email':
      return email ? { user: email, email } : undefined;
    case 'email-localpart': {
      if (!email) return undefined;
      const at = email.indexOf('@');
      const localpart = at > 0 ? email.slice(0, at) : email;
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
 */
export class PrincipalResolver {
  private readonly trusted: ParsedCidr[];

  constructor(private readonly auth: AuthConfig) {
    this.trusted = parseCidrList(auth.trustedProxyCidrs);
  }

  /** True when the peer address falls inside a trusted-proxy CIDR. */
  isTrusted(remoteAddress: string | undefined): boolean {
    return isTrustedAddress(this.trusted, remoteAddress);
  }

  /**
   * Resolve a request's principal in `proxy` mode. SSO headers are honored only
   * when the peer is a trusted proxy; otherwise (untrusted peer, or missing
   * headers) the request is unauthenticated and the caller returns 401.
   */
  resolve(
    headers: Record<string, string | undefined>,
    remoteAddress: string | undefined,
  ): ResolveResult {
    if (!this.isTrusted(remoteAddress)) {
      return { ok: false, reason: 'Request did not originate from a trusted proxy' };
    }
    const userHeader = header(headers, this.auth.ssoHeaderUser);
    const emailHeader = header(headers, this.auth.ssoHeaderEmail);
    const principal = mapPrincipal(this.auth.userMapping, userHeader, emailHeader);
    if (!principal) {
      return { ok: false, reason: 'No SSO identity headers present' };
    }
    return { ok: true, principal };
  }
}

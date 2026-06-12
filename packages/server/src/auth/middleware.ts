import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { UNAUTHENTICATED } from '@hubble/contracts';
import type { AuthConfig } from '../config';
import { AppError } from '../errors';
import { PrincipalResolver, type Principal } from './principal';

/** Hono `c.var` bindings set by the auth middleware. */
export interface AuthVariables {
  /** The authenticated identity for the request (design.md §11). */
  principal: Principal;
}

/**
 * Extract the peer's remote address. Defaults to `@hono/node-server`'s
 * connection-info helper; injectable so tests can drive the trust decision
 * without a real socket.
 */
export type RemoteAddressFn = (c: Context) => string | undefined;

const defaultRemoteAddress: RemoteAddressFn = (c) => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
};

export interface AuthMiddlewareOptions {
  auth: AuthConfig;
  /** Principal used in `none` mode (owner id + Trino user) — the technical user. */
  noneModeUser: string;
  /** Override the remote-address source (tests). */
  remoteAddress?: RemoteAddressFn;
}

/** Throw the contract 401 `{ error: { code: 'UNAUTHENTICATED' } }` envelope. */
function unauthenticated(reason: string): never {
  throw new AppError(401, { code: UNAUTHENTICATED, message: reason });
}

/**
 * Authentication middleware (design.md §11). Resolves a `Principal` and exposes
 * it via `c.set('principal', …)`.
 *
 * - `none` mode: every request is authenticated as the technical user.
 * - `proxy` mode: the principal is resolved from trusted SSO headers; requests
 *   from untrusted peers or without identity headers get 401.
 *
 * `/api/healthz` is always exempt. Static assets are served outside the API and
 * never reach this middleware (it is mounted under `/api`).
 */
export function authMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler {
  const { auth, noneModeUser } = options;
  const remoteAddress = options.remoteAddress ?? defaultRemoteAddress;
  const resolver = auth.mode === 'proxy' ? new PrincipalResolver(auth) : undefined;

  return async (c, next) => {
    if (auth.mode === 'none' || resolver === undefined) {
      c.set('principal', { user: noneModeUser });
      await next();
      return;
    }
    const result = resolver.resolve(c.req.header(), remoteAddress(c));
    if (!result.ok) {
      unauthenticated(result.reason);
    }
    c.set('principal', result.principal);
    await next();
  };
}

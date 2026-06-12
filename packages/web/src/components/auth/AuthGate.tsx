import type { ReactNode } from 'react';
import { useMe, isUnauthenticated } from '../../hooks/useMe';
import { AuthRequired } from './AuthRequired';

/**
 * Gate the app on authentication (design.md §11). `/api/me` is the canonical
 * probe: in `proxy` mode an unauthenticated request (direct access / expired
 * session) returns 401 UNAUTHENTICATED, and we swap the whole UI for the
 * "authentication required" screen. In `none` mode `/api/me` always succeeds,
 * so the gate is transparent.
 *
 * While the probe is in flight we render the app optimistically; behind an
 * oauth2-proxy the request resolves immediately and there is no flash.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { error } = useMe();
  if (isUnauthenticated(error)) return <AuthRequired />;
  return <>{children}</>;
}

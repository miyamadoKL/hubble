import { ShieldAlert } from 'lucide-react';
import { Logo } from '../layout/Logo';
import { EmptyState } from '../common/EmptyState';
import { Button } from '../common/Button';

/**
 * Full-screen "authentication required" state (design.md §11). Shown when an
 * API request returns 401 UNAUTHENTICATED — i.e. direct access outside the
 * oauth2-proxy, or an expired SSO session. Reuses the EmptyState tone and the
 * design tokens only (no raw hex). Reloading re-enters the proxy's auth flow.
 */
export function AuthRequired() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-8 bg-surface-base px-6 text-ink-base">
      <Logo />
      <EmptyState
        icon={ShieldAlert}
        title="認証が必要です"
        description="このセッションは認証されていません。シングルサインオンでログインし直してください。"
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            再読み込み
          </Button>
        }
      />
    </div>
  );
}

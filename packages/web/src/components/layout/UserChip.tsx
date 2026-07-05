/**
 * TopBar 右端に表示する「現在のユーザー」チップコンポーネント。
 * 認証済みユーザーのイニシャルとユーザー名を表示する。認証なしモード
 * （authMode === 'none'）では何も表示しない。
 * クリック時には実効ロール、権限、アクセス可能なデータソースを表示する。
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Database, GitFork, ShieldCheck } from 'lucide-react';
import { useMe } from '../../hooks/useMe';
import { useDisconnectGithub, useGithubStatus } from '../../hooks/useGithub';
import { githubConnectUrl } from '../../api/github';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';

/**
 * Current-user chip for the TopBar. Shows the resolved principal. Hidden
 * entirely in `authMode === 'none'`, where there is no meaningful user identity.
 * Clicking it opens a compact popover with the effective RBAC role,
 * permissions, and datasources.
 */
/**
 * 現在ログイン中のユーザーを示すチップを描画する。props は取らず、
 * `useMe` フックでサーバーから解決済みの principal 情報を取得して表示する。
 * 未取得時、または authMode が 'none'（認証なし運用）の場合は何も描画しない。
 */
export function UserChip() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // サーバーから現在のユーザー情報を取得する。
  const { data: me } = useMe();
  // GitHub 連携の有効状態と自分の接続状態 (機能無効なら enabled=false)。
  const { data: github } = useGithubStatus();
  const disconnectGithub = useDisconnectGithub();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // 未取得、または認証なしモードのときはチップ自体を表示しない。
  if (!me || me.authMode === 'none') return null;

  // アバター代わりに表示するユーザー名の頭文字（大文字化）。
  const initial = me.user.charAt(0).toUpperCase();
  const identity = me.email ?? me.user;
  const permissions = [...me.permissions].sort();
  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex h-8 items-center gap-2 rounded-md border py-1 pr-2 pl-1.5 text-ink-base transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          open
            ? 'border-accent bg-accent-soft text-accent ring-1 ring-accent/30'
            : 'border-border-subtle bg-surface-sunken hover:bg-surface-raised',
        )}
        data-testid="user-chip"
      >
        {/* イニシャルを丸バッジで表示するアバター部分。 */}
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft font-mono text-2xs font-semibold text-accent">
          {initial}
        </span>
        {/* ユーザー名本体。長い場合は truncate で省略表示する。 */}
        <span className="max-w-[10rem] truncate text-xs font-medium">{me.user}</span>
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Current identity"
          className="absolute top-full right-0 z-50 mt-2 w-80 rounded-md border border-border-strong bg-surface-overlay p-3 text-sm text-ink-base shadow-lg"
        >
          <div className="min-w-0 border-b border-border-subtle pb-3">
            <div className="truncate font-medium">{identity}</div>
            {me.email && me.email !== me.user && (
              <div className="mt-0.5 truncate font-mono text-2xs text-ink-muted">{me.user}</div>
            )}
          </div>

          <div className="mt-3 space-y-3">
            <section>
              <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold text-ink-muted uppercase">
                <ShieldCheck size={13} strokeWidth={1.75} />
                Role
              </div>
              <div className="inline-flex rounded-sm border border-border-subtle bg-surface-sunken px-2 py-1 font-mono text-xs">
                {me.role}
              </div>
            </section>

            <section>
              <div className="mb-1.5 text-2xs font-semibold text-ink-muted uppercase">
                Permissions
              </div>
              {permissions.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {permissions.map((permission) => (
                    <span
                      key={permission}
                      className="rounded-sm border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs"
                    >
                      {permission}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-ink-muted">No permissions</div>
              )}
            </section>

            <section>
              <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold text-ink-muted uppercase">
                <Database size={13} strokeWidth={1.75} />
                Datasources
              </div>
              {me.datasources.length > 0 ? (
                <div className="max-h-40 space-y-1 overflow-auto">
                  {me.datasources.map((datasource) => (
                    <div
                      key={datasource.id}
                      className="rounded-sm border border-border-subtle bg-surface-sunken px-2 py-1.5"
                    >
                      <div className="truncate text-xs font-medium">{datasource.displayName}</div>
                      <div className="mt-0.5 truncate font-mono text-2xs text-ink-muted">
                        {datasource.id}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-ink-muted">No datasources</div>
              )}
            </section>

            {/* GitHub 連携 (サーバー側で有効な場合のみ表示)。接続、解除を行う。 */}
            {github?.enabled && (
              <section>
                <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold text-ink-muted uppercase">
                  <GitFork size={13} strokeWidth={1.75} />
                  GitHub
                </div>
                {github.connected ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs">@{github.login}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        disconnectGithub.mutate(undefined, {
                          onSuccess: () => toast.info('Disconnected', 'GitHub account unlinked.'),
                          onError: () =>
                            toast.error('Disconnect failed', 'Could not reach the server.'),
                        })
                      }
                      disabled={disconnectGithub.isPending}
                    >
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    icon={GitFork}
                    onClick={() => window.location.assign(githubConnectUrl())}
                  >
                    Connect GitHub
                  </Button>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useMe } from '../../hooks/useMe';
import { Tooltip } from '../common/Tooltip';

/**
 * Current-user chip for the TopBar (design.md §11). Shows the resolved
 * principal (with the email as a tooltip when available). Hidden entirely in
 * `authMode === 'none'`, where there is no meaningful user identity.
 */
export function UserChip() {
  const { data: me } = useMe();
  if (!me || me.authMode === 'none') return null;

  const initial = me.user.charAt(0).toUpperCase();
  return (
    <Tooltip label={me.email ?? me.user}>
      <span
        className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-sunken py-1 pr-2.5 pl-1.5 text-ink-base"
        data-testid="user-chip"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft font-mono text-2xs font-semibold text-accent">
          {initial}
        </span>
        <span className="max-w-[10rem] truncate text-xs font-medium">{me.user}</span>
      </span>
    </Tooltip>
  );
}

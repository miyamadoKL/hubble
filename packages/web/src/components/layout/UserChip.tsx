/**
 * TopBar 右端に表示する「現在のユーザー」チップコンポーネント。
 * 認証済みユーザーのイニシャルとユーザー名を表示し、メールアドレスがあれば
 * ツールチップで補足する。認証なしモード（authMode === 'none'）では何も表示しない。
 */
import { useMe } from '../../hooks/useMe';
import { Tooltip } from '../common/Tooltip';

/**
 * Current-user chip for the TopBar. Shows the resolved
 * principal (with the email as a tooltip when available). Hidden entirely in
 * `authMode === 'none'`, where there is no meaningful user identity.
 */
/**
 * 現在ログイン中のユーザーを示すチップを描画する。props は取らず、
 * `useMe` フックでサーバーから解決済みの principal 情報を取得して表示する。
 * 未取得時、または authMode が 'none'（認証なし運用）の場合は何も描画しない。
 */
export function UserChip() {
  // サーバーから現在のユーザー情報を取得する。
  const { data: me } = useMe();
  // 未取得、または認証なしモードのときはチップ自体を表示しない。
  if (!me || me.authMode === 'none') return null;

  // アバター代わりに表示するユーザー名の頭文字（大文字化）。
  const initial = me.user.charAt(0).toUpperCase();
  const identity = me.email ?? me.user;
  return (
    // メールアドレスまたはユーザー名と、解決済みロール名をツールチップで表示する。
    <Tooltip
      label={
        <span className="block text-center">
          {identity}
          <span className="mt-0.5 block font-mono text-2xs text-ink-muted">Role: {me.role}</span>
        </span>
      }
    >
      <span
        className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-sunken py-1 pr-2.5 pl-1.5 text-ink-base"
        data-testid="user-chip"
      >
        {/* イニシャルを丸バッジで表示するアバター部分。 */}
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft font-mono text-2xs font-semibold text-accent">
          {initial}
        </span>
        {/* ユーザー名本体。長い場合は truncate で省略表示する。 */}
        <span className="max-w-[10rem] truncate text-xs font-medium">{me.user}</span>
      </span>
    </Tooltip>
  );
}

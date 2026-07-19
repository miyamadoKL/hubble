/**
 * ドキュメント共有の所有者と permission を示す小さなバッジ。
 * SavedQueriesPanel や NotebookListPanel など一覧行で使う。
 */
import type { MyPermission } from '@hubble/contracts';
import { cn } from '../../utils/cn';
import { isSharedWithMe, sharePermissionLabel } from '../../utils/documentShare';
import { useT } from '../../i18n/t';
import { useLocale } from '../../i18n/locale';
import { shareMessages } from '../../i18n/messages/share';

/**
 * 共有ドキュメント向けのバッジ（"shared by alice" + view/edit）。
 *
 * @param owner 所有者の user id。
 * @param myPermission 呼び出し元の effective permission。
 * @param className 追加の Tailwind クラス。
 */
export function DocumentShareBadge({
  owner,
  myPermission,
  className,
}: {
  owner?: string;
  myPermission?: MyPermission;
  className?: string;
}) {
  const t = useT(shareMessages);
  const { locale } = useLocale();
  // permission が欠落した保存済み応答は共有表示を推測せず、そのまま隠す。
  if (myPermission === undefined || !isSharedWithMe(myPermission) || !owner) return null;
  const permission = myPermission === 'edit' ? 'edit' : 'view';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-2xs text-ink-muted',
        className,
      )}
    >
      {t('sharedByLabel', { owner, permission: sharePermissionLabel(permission, locale) })}
    </span>
  );
}

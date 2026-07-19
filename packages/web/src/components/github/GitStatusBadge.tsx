/**
 * ドキュメントの Git 承認ステータスを示すバッジ。
 * approved (緑) / in review (青) / modified (黄) / unlinked (グレー) を
 * 色とラベルで区別し、「GitHub 連携済みで未反映変更なし」かどうかが一目で分かる。
 */
import type { DocumentGitStatus } from '@hubble/contracts';
import { GitBranch, GitPullRequest, CircleCheck, CircleDashed } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { githubPanelMessages } from '../../i18n/messages/githubPanel';

// ステータスラベルの辞書キー（プレースホルダーを持たないキーのみに限定する）。
// keyof typeof githubPanelMessages のような広い union にすると、t() の引数型が
// プレースホルダーありのキーとの union になり呼び出し側で型エラーになるため、
// 使用するキーだけの union で narrow している。
type StatusLabelKey = 'statusApproved' | 'statusInReview' | 'statusModified' | 'statusUnlinked';

// ステータスごとの表示定義 (ラベルキー、色、アイコン)。ラベルは辞書キーで持ち、
// 実際の文字列は描画時に useT で引く。
const STATUS_VIEW: Record<
  DocumentGitStatus,
  { labelKey: StatusLabelKey; className: string; icon: LucideIcon }
> = {
  approved: {
    labelKey: 'statusApproved',
    className: 'bg-success-soft text-success',
    icon: CircleCheck,
  },
  in_review: {
    labelKey: 'statusInReview',
    className: 'bg-running-soft text-running',
    icon: GitPullRequest,
  },
  modified: {
    labelKey: 'statusModified',
    className: 'bg-warning-soft text-warning',
    icon: GitBranch,
  },
  unlinked: {
    labelKey: 'statusUnlinked',
    className: 'bg-surface-inset text-ink-muted',
    icon: CircleDashed,
  },
};

/**
 * Git ステータスバッジを描画する。
 * @param status 表示対象のステータス。
 * @param stale GitHub への検証が失敗しキャッシュ値で表示していることを示すフラグ。
 * @param className 追加の Tailwind クラス。
 */
export function GitStatusBadge({
  status,
  stale,
  className,
}: {
  status: DocumentGitStatus;
  stale?: boolean;
  className?: string;
}) {
  const t = useT(githubPanelMessages);
  const view = STATUS_VIEW[status];
  const Icon = view.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'font-mono text-2xs font-medium tracking-wide uppercase',
        view.className,
        className,
      )}
      title={stale ? t('staleStatusTitle') : undefined}
    >
      <Icon size={11} strokeWidth={2} />
      {t(view.labelKey)}
      {stale && <span aria-hidden>*</span>}
    </span>
  );
}

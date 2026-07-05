/**
 * ドキュメントの Git 承認ステータスを示すバッジ。
 * approved (緑) / in review (青) / modified (黄) / unlinked (グレー) を
 * 色とラベルで区別し、「GitHub 連携済みで未反映変更なし」かどうかが一目で分かる。
 */
import type { DocumentGitStatus } from '@hubble/contracts';
import { GitBranch, GitPullRequest, CircleCheck, CircleDashed } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

// ステータスごとの表示定義 (ラベル、色、アイコン)。
const STATUS_VIEW: Record<
  DocumentGitStatus,
  { label: string; className: string; icon: LucideIcon }
> = {
  approved: { label: 'approved', className: 'bg-success-soft text-success', icon: CircleCheck },
  in_review: {
    label: 'in review',
    className: 'bg-running-soft text-running',
    icon: GitPullRequest,
  },
  modified: { label: 'modified', className: 'bg-warning-soft text-warning', icon: GitBranch },
  unlinked: { label: 'unlinked', className: 'bg-surface-inset text-ink-muted', icon: CircleDashed },
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
      title={stale ? 'GitHub could not be reached; showing cached status' : undefined}
    >
      <Icon size={11} strokeWidth={2} />
      {view.label}
      {stale && <span aria-hidden>*</span>}
    </span>
  );
}

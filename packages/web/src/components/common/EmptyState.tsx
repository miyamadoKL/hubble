/**
 * データが存在しない場合や検索結果が空の場合に表示する「空状態 (empty state)」コンポーネント。
 * サイドバーパネルや結果表示エリアなど、アプリ内で共通して使用する。
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

/** EmptyState コンポーネントに渡す props。 */
interface EmptyStateProps {
  /** 中央に表示する lucide-react のアイコン。 */
  icon: LucideIcon;
  /** 空状態の見出しテキスト。 */
  title: string;
  /** 見出しの下に表示する補足説明（任意）。 */
  description?: string;
  /** 補足説明の下に表示するアクション要素（ボタンなど、任意）。 */
  action?: ReactNode;
  /** ルート要素に付与する追加の className。 */
  className?: string;
  /** Compact variant for narrow sidebar panels. */
  /** 狭いサイドバーパネル向けのコンパクト表示にする場合は true。 */
  compact?: boolean;
}

/**
 * Empty-state design for sidebar panels and result areas (design.md §6).
 *
 * icon、title、description、action を受け取り、中央揃えの空状態 UI を描画する。
 * compact が true の場合はアイコンや余白のサイズを小さくしたコンパクト表示になる。
 *
 * @param props - EmptyStateProps（icon, title, description, action, className, compact）
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-12',
        className,
      )}
    >
      {/* アイコンを丸みのある枠で囲んで中央に表示する */}
      <span
        className={cn(
          'flex items-center justify-center rounded-lg border border-border-subtle bg-surface-sunken text-ink-subtle',
          compact ? 'h-9 w-9' : 'h-12 w-12',
        )}
      >
        <Icon size={compact ? 18 : 22} strokeWidth={1.5} />
      </span>
      {/* タイトルと、description が指定されていればその説明文を表示する */}
      <div className="space-y-1">
        <p className={cn('font-medium text-ink-base', compact ? 'text-sm' : 'text-base')}>
          {title}
        </p>
        {description && (
          <p className={cn('text-ink-muted', compact ? 'text-xs' : 'text-sm')}>{description}</p>
        )}
      </div>
      {/* action が指定されていれば、その下にアクション要素（ボタン等）を表示する */}
      {action}
    </div>
  );
}

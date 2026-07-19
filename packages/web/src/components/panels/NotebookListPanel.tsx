/**
 * ノートブック一覧パネル（アシストサイドバー内）。
 *
 * `GET /api/notebooks` から取得済みのノートブック一覧を props で受け取り、各項目に
 * 名前、説明、最終更新の相対時刻を表示する。現在開いているノートブックはハイライト
 * 表示され、行をクリックすると `onOpen` コールバック経由で該当ノートブックを開く。
 * このコンポーネント自身はデータ取得を行わない（呼び出し元が一覧を渡す構成）。
 */
import type { NotebookListItem } from '@hubble/contracts';
import { FileCode2, NotebookPen } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';
import { DocumentShareBadge } from '../common/DocumentShareBadge';
import { formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { useLocale } from '../../i18n/locale';
import { commonMessages } from '../../i18n/messages/common';
import { panelsMessages } from '../../i18n/messages/panels';

/** NotebookListPanel 内で使う辞書の合成。共通文言（No notebooks）+ panels 固有文言。 */
const notebookListDict = { ...commonMessages, ...panelsMessages } as const;

/**
 * ノートブック一覧を描画するコンポーネント。
 *
 * @param notebooks 表示するノートブック一覧（軽量な NotebookListItem の配列）。
 * @param activeId 現在アクティブなノートブックの id。一致する行がハイライトされる。
 * @param onOpen 行クリック時に呼び出されるコールバック。クリックされたノートブックの id を渡す。
 * @param className 外側の `<ul>` に追加で適用する Tailwind クラス。
 */
export function NotebookListPanel({
  notebooks,
  activeId,
  onOpen,
  className,
}: {
  notebooks: NotebookListItem[];
  activeId?: string;
  onOpen?: (id: string) => void;
  className?: string;
}) {
  const t = useT(notebookListDict);
  const { locale } = useLocale();
  // 相対時刻表示（"3分前" など）の基準となる現在時刻。
  const now = new Date();
  // ノートブックが 1 件も無い場合は空状態を表示して終了する。
  if (notebooks.length === 0) {
    return (
      <EmptyState
        icon={NotebookPen}
        title={t('noNotebooks')}
        description={t('createNotebookHint')}
        compact
      />
    );
  }
  return (
    <ul className={cn('flex flex-col', className)}>
      {notebooks.map((nb) => {
        // このノートブックが現在アクティブ（開かれている）かどうかを判定する。
        const active = nb.id === activeId;
        return (
          <li key={nb.id} className="border-b border-border-subtle">
            {/* 行全体がクリック可能なボタン。クリックで onOpen(nb.id) を呼び出す。 */}
            <button
              type="button"
              aria-current={active || undefined}
              onClick={() => onOpen?.(nb.id)}
              className={cn(
                'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
                active ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
              )}
            >
              {/* ノートブックを表すファイルアイコン。アクティブ時はアクセントカラーになる。 */}
              <FileCode2
                size={15}
                strokeWidth={1.75}
                className={cn('mt-0.5 shrink-0', active ? 'text-accent' : 'text-ink-muted')}
              />
              <div className="min-w-0 flex-1">
                {/* ノートブック名 */}
                <p
                  className={cn(
                    'truncate text-sm font-medium',
                    active ? 'text-accent' : 'text-ink-strong',
                  )}
                >
                  {nb.name}
                </p>
                {/* 説明文（設定されている場合のみ表示） */}
                {nb.description && (
                  <p className="mt-0.5 truncate text-xs text-ink-muted">{nb.description}</p>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-2xs text-ink-subtle">
                  <DocumentShareBadge owner={nb.owner} myPermission={nb.myPermission} />
                  <span>{formatRelativeTime(nb.updatedAt, now, locale)}</span>
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * WidgetCard.tsx
 *
 * ダッシュボードグリッドの 1 パネル分のカード。query widget は
 * useWidgetData で参照先クエリを実行して QueryWidgetBody へ渡し、
 * text widget は Markdown をそのまま描画する。ヘッダーにはタイトルと、
 * リフレッシュ (query のみ) と編集モード時の削除ボタンを表示する。
 */
import { RefreshCw, Trash2 } from 'lucide-react';
import type { DashboardWidget, QueryWidget } from '@hubble/contracts';
import { Markdown } from '../notebook/Markdown';
import { Tooltip } from '../common/Tooltip';
import { QueryWidgetBody } from './QueryWidgetBody';
import { useWidgetData } from './useWidgetData';
import { cn } from '../../utils/cn';

/** query widget のカード本体 (データ取得込み)。 */
function QueryWidgetCard({
  widget,
  editing,
  onRemove,
}: {
  widget: QueryWidget;
  editing: boolean;
  onRemove: () => void;
}) {
  const data = useWidgetData(widget.savedQueryId);
  // タイトルは widget の明示タイトル → 保存クエリ名 → id の順にフォールバックする。
  const title = widget.title?.trim() || data.queryName || widget.savedQueryId;
  return (
    <WidgetChrome
      title={title}
      editing={editing}
      onRemove={onRemove}
      actions={
        <Tooltip label="Refresh" side="bottom">
          <button
            type="button"
            aria-label="Refresh widget"
            onClick={data.refresh}
            disabled={data.loading}
            className="rounded-sm p-1 text-ink-subtle hover:text-ink-strong disabled:opacity-50"
          >
            <RefreshCw
              size={13}
              strokeWidth={1.75}
              className={cn(data.loading && 'animate-spin')}
            />
          </button>
        </Tooltip>
      }
    >
      <QueryWidgetBody
        widget={widget}
        loading={data.loading}
        error={data.error}
        columns={data.columns}
        rows={data.rows}
      />
    </WidgetChrome>
  );
}

/** カードの共通枠 (ヘッダー + 本文領域)。 */
function WidgetChrome({
  title,
  editing,
  onRemove,
  actions,
  children,
}: {
  title: string;
  editing: boolean;
  onRemove: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-border-base bg-surface-base shadow-sm">
      <div
        className={cn(
          'flex shrink-0 items-center gap-1 border-b border-border-subtle px-2.5 py-1.5',
          // 編集モード中はヘッダーがドラッグハンドルになる (grid 側の draggableHandle と対応)。
          editing && 'dashboard-widget-drag-handle cursor-move',
        )}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-strong">{title}</span>
        {actions}
        {editing && (
          <Tooltip label="Remove widget" side="bottom">
            <button
              type="button"
              aria-label="Remove widget"
              onClick={onRemove}
              className="rounded-sm p-1 text-ink-subtle hover:text-error"
            >
              <Trash2 size={13} strokeWidth={1.75} />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * widget 1 件分のカード。kind に応じて query / text の描画を出し分ける。
 * @param widget 対象 widget。
 * @param editing 編集モード中かどうか (削除ボタンとドラッグハンドルの表示に影響)。
 * @param onRemove 削除ボタン押下時のコールバック。
 */
export function WidgetCard({
  widget,
  editing,
  onRemove,
}: {
  widget: DashboardWidget;
  editing: boolean;
  onRemove: () => void;
}) {
  if (widget.kind === 'query') {
    return <QueryWidgetCard widget={widget} editing={editing} onRemove={onRemove} />;
  }
  return (
    <WidgetChrome title="Text" editing={editing} onRemove={onRemove}>
      <div className="h-full overflow-auto p-3">
        <Markdown source={widget.text} />
      </div>
    </WidgetChrome>
  );
}

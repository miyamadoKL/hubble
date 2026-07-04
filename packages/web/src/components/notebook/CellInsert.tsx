/**
 * CellInsert.tsx
 *
 * ノートブックのセルとセルの間に配置される、新規セル挿入用のコントロール。
 * 通常はほぼ見えない細い横線として表示され、ホバーすると「+ SQL」「+ Markdown」
 * ボタンが浮かび上がる。クリックすると、そのスロット（隙間）位置に新しいセルを挿入する。
 */
import { Code2, FileText, Plus } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Inter-cell insertion control (「+ SQL / + Markdown」挿入 UI).
 * A faint hairline with centered actions that surface on hover; clicking inserts
 * a new cell at this slot.
 */
/**
 * セル挿入コントロール本体。
 *
 * @param onAddSql - 「+ SQL」ボタンが押されたときに呼ばれる（この位置に SQL セルを挿入する）。
 * @param onAddMarkdown - 「+ Markdown」ボタンが押されたときに呼ばれる（この位置に Markdown セルを挿入する）。
 * @param className - 呼び出し元から追加のスタイルを指定するための任意クラス名。
 */
export function CellInsert({
  onAddSql,
  onAddMarkdown,
  className,
}: {
  onAddSql: () => void;
  onAddMarkdown: () => void;
  className?: string;
}) {
  return (
    <div className={cn('group relative flex h-6 items-center justify-center', className)}>
      {/* 通常時に見える細い横線（ハーフライン）。group-hover で少し濃い色に変化する。 */}
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border-subtle transition-colors group-hover:bg-border-base" />
      {/* ホバー時（または内部要素にフォーカスが当たったとき）にのみ表示される挿入ボタン群。 */}
      <div className="relative flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {/* SQL セルを挿入するボタン。 */}
        <button
          type="button"
          onClick={onAddSql}
          className="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface-raised px-2 py-0.5 text-2xs font-medium text-ink-muted shadow-sm hover:border-accent hover:text-accent"
        >
          <Plus size={11} strokeWidth={2} />
          <Code2 size={11} strokeWidth={1.75} />
          SQL
        </button>
        {/* Markdown セルを挿入するボタン。 */}
        <button
          type="button"
          onClick={onAddMarkdown}
          className="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface-raised px-2 py-0.5 text-2xs font-medium text-ink-muted shadow-sm hover:border-accent hover:text-accent"
        >
          <Plus size={11} strokeWidth={2} />
          <FileText size={11} strokeWidth={1.75} />
          Markdown
        </button>
      </div>
    </div>
  );
}

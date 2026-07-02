/**
 * CellToolbar.tsx
 *
 * ノートブックの各セル（SQL / Markdown）上部に表示されるツールバー。
 * セルの折りたたみ、種別バッジ、名前の編集、SQL セルの実行/停止、
 * LIMIT 自動付与の切り替え、セルの並べ替えや削除、ドラッグハンドルなど、
 * セル単位の操作をひとまとめに提供するコンポーネント群。
 */
import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Play,
  Square,
  Trash2,
} from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { Kbd } from '../common/Kbd';
import { Tooltip } from '../common/Tooltip';
import { cn } from '../../utils/cn';

/**
 * Cell toolbar (design.md §6): collapse / kind badge / editable name, plus run /
 * stop, the LIMIT auto-append toggle (SQL cells, design.md §5), move up/down,
 * delete, and the drag grip handle. Move/delete/rename are notebook-level
 * operations passed down from NotebookView; run/limit are SQL-cell-owned.
 */

/**
 * CellToolbar コンポーネントに渡す props の型。
 * セルの見た目や状態と、各操作に対応するコールバック群をまとめている。
 */
interface CellToolbarProps {
  /** セルの種類。'sql' なら実行系ボタンや LIMIT コントロールも表示する。 */
  kind: 'sql' | 'markdown';
  /** セルの表示名（未設定なら「Untitled cell」というプレースホルダーを出す）。 */
  name?: string;
  /** true のときセル本体を折りたたみ表示にする。 */
  collapsed: boolean;
  /** true のときクエリ実行中とみなし、実行ボタンを停止ボタンに切り替える。 */
  running?: boolean;
  /** LIMIT auto-append controls (SQL cells only). */
  /** LIMIT を自動付与するかどうかのフラグ（SQL セルのみ使用）。 */
  autoLimit?: boolean;
  /** LIMIT の行数（SQL セルのみ使用）。 */
  limit?: number;
  /** True when this cell cannot move further in that direction. */
  /** これ以上上へ移動できない場合は false（上移動ボタンの活性制御に使用）。 */
  canMoveUp?: boolean;
  /** これ以上下へ移動できない場合は false（下移動ボタンの活性制御に使用）。 */
  canMoveDown?: boolean;
  /** 折りたたみ状態を切り替えるときに呼ばれる。 */
  onToggleCollapse: () => void;
  /** セル名の編集が確定したときに、新しい名前を渡して呼ばれる。 */
  onRename: (name: string) => void;
  /** 実行ボタン押下時に呼ばれる（SQL セルのみ）。 */
  onRun?: () => void;
  /** 実行中に停止ボタンを押したときに呼ばれる（SQL セルのみ）。 */
  onCancel?: () => void;
  /** Query Guard: disable run (block verdict) and explain why in the tooltip. */
  /** Query Guard によって実行がブロックされている場合 true。実行ボタンを無効化する。 */
  runDisabled?: boolean;
  /** runDisabled が true のときにツールチップへ表示する理由文言。 */
  runDisabledReason?: string;
  /** LIMIT 自動付与の ON/OFF を切り替えるときに呼ばれる。 */
  onToggleAutoLimit?: () => void;
  /** LIMIT の値が変更されたときに、新しい値を渡して呼ばれる。 */
  onLimitChange?: (limit: number) => void;
  /** セルを一つ上へ移動するときに呼ばれる。 */
  onMoveUp?: () => void;
  /** セルを一つ下へ移動するときに呼ばれる。 */
  onMoveDown?: () => void;
  /** セルを削除するときに呼ばれる。 */
  onDelete?: () => void;
  /** Drag handle props supplied by the DnD container in NotebookView. */
  /** NotebookView 側の DnD コンテナから渡される、ドラッグハンドル用の props。 */
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
}

/**
 * セルツールバー本体。折りたたみボタン、種別バッジ、セル名、（SQL セルのみ）
 * LIMIT コントロールと実行/停止ボタン、上下移動や削除ボタン、ドラッグハンドルを
 * 横一列に並べて表示する。表示/挙動の状態はすべて props 経由で親から渡され、
 * このコンポーネント自身は状態を持たない（純粋な表示コンポーネント）。
 *
 * @param props - CellToolbarProps。各フィールドの意味は型定義側のコメントを参照。
 */
export function CellToolbar({
  kind,
  name,
  collapsed,
  running = false,
  autoLimit = true,
  limit = 5000,
  canMoveUp = true,
  canMoveDown = true,
  onToggleCollapse,
  onRename,
  onRun,
  onCancel,
  runDisabled = false,
  runDisabledReason,
  onToggleAutoLimit,
  onLimitChange,
  onMoveUp,
  onMoveDown,
  onDelete,
  dragHandleProps,
}: CellToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border-subtle bg-surface-raised px-2 py-1.5">
      {/* 折りたたみ/展開トグルボタン。collapsed の値によって矢印アイコンを出し分ける。 */}
      <button
        type="button"
        aria-label={collapsed ? 'Expand cell' : 'Collapse cell'}
        onClick={onToggleCollapse}
        className="rounded-sm p-0.5 text-ink-subtle hover:text-ink-strong"
      >
        {collapsed ? (
          <ChevronRight size={14} strokeWidth={2} />
        ) : (
          <ChevronDown size={14} strokeWidth={2} />
        )}
      </button>

      {/* セル種別バッジ（sql / markdown）。種類によって配色を変える。 */}
      <span
        className={cn(
          'rounded-xs px-1.5 py-0.5 font-mono text-2xs font-medium tracking-wide uppercase',
          kind === 'sql' ? 'bg-accent-soft text-accent' : 'bg-surface-inset text-ink-muted',
        )}
      >
        {kind}
      </span>

      {/* セル名のインライン編集コンポーネント。 */}
      <CellName name={name} onRename={onRename} />

      {/* 右寄せの操作群: LIMIT、実行/停止、移動、削除、ドラッグハンドル。 */}
      <div className="ml-auto flex items-center gap-1.5">
        {/* SQL セルのみ LIMIT 自動付与コントロールを表示する。 */}
        {kind === 'sql' && (
          <LimitControl
            autoLimit={autoLimit}
            limit={limit}
            onToggle={onToggleAutoLimit}
            onLimitChange={onLimitChange}
          />
        )}
        {/* SQL セルのみ実行/停止ボタンを表示する。running の状態でアイコンと挙動を切り替える。 */}
        {kind === 'sql' && (
          <Tooltip
            label={
              running ? (
                <span className="flex items-center gap-1.5">
                  Stop <Kbd keys={['Ctrl', '↵']} />
                </span>
              ) : runDisabled ? (
                // Query Guard block: explain why the run is unavailable.
                // Query Guard によって実行がブロックされている場合、その理由をツールチップに表示する。
                <span className="block max-w-xs whitespace-normal text-left">
                  {runDisabledReason ?? 'Blocked by Query Guard'}
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  Run cell <Kbd keys={['Ctrl', '↵']} />
                </span>
              )
            }
          >
            {running ? (
              // 実行中: 停止ボタン（危険色）を表示。
              <IconButton
                icon={Square}
                label="Stop"
                variant="danger"
                size="sm"
                tooltip={false}
                onClick={onCancel}
              />
            ) : (
              // 非実行中: 実行ボタン。Query Guard によるブロック時は disabled にする。
              <IconButton
                icon={Play}
                label={runDisabled ? 'Run blocked by Query Guard' : 'Run cell'}
                variant="accent"
                size="sm"
                tooltip={false}
                disabled={runDisabled}
                onClick={onRun}
              />
            )}
          </Tooltip>
        )}
        {/* セルを上へ移動するボタン。先頭セルなど移動不可な場合は disabled。 */}
        <IconButton
          icon={ChevronUp}
          label="Move up"
          size="sm"
          disabled={!canMoveUp}
          onClick={onMoveUp}
        />
        {/* セルを下へ移動するボタン。末尾セルなど移動不可な場合は disabled。 */}
        <IconButton
          icon={ChevronDown}
          label="Move down"
          size="sm"
          disabled={!canMoveDown}
          onClick={onMoveDown}
        />
        {/* セル削除ボタン。 */}
        <IconButton
          icon={Trash2}
          label="Delete cell"
          variant="danger"
          size="sm"
          onClick={onDelete}
        />
        {/* ドラッグして並べ替えるためのグリップハンドル。dragHandleProps は DnD ライブラリから渡される。 */}
        <span
          {...dragHandleProps}
          aria-label="Drag to reorder"
          role="button"
          tabIndex={0}
          className="ml-0.5 cursor-grab text-ink-subtle hover:text-ink-muted active:cursor-grabbing"
        >
          <GripVertical size={15} strokeWidth={1.75} />
        </span>
      </div>
    </div>
  );
}

/**
 * Inline-editable cell name: double-click (or the placeholder) to rename.
 * セル名をインライン編集できる小さなコンポーネント。ダブルクリックで編集モードに入り、
 * blur / Enter で確定、Escape でキャンセルする。
 *
 * @param name - 現在のセル名（未設定なら「Untitled cell」を表示）。
 * @param onRename - 編集内容が確定したときに、トリム済みの新しい名前を渡して呼ばれる。
 */
function CellName({ name, onRename }: { name?: string; onRename: (name: string) => void }) {
  // editing: 編集モード中かどうか。true のときは <input> を表示する。
  const [editing, setEditing] = useState(false);
  // draft: 編集中の入力値（未確定の下書き）。
  const [draft, setDraft] = useState(name ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // 編集モードに入ったタイミングで入力欄へフォーカスし、既存テキストを全選択する。
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // 編集内容を確定する処理: 編集モードを終了し、トリムした値を親へ通知する。
  const commit = () => {
    setEditing(false);
    onRename(draft.trim());
  };

  if (editing) {
    // 編集モード: テキスト入力欄を表示する。
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Cell name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            // Escape: 編集内容を破棄して元の名前に戻す。
            setDraft(name ?? '');
            setEditing(false);
          }
        }}
        placeholder="Cell name"
        className="w-40 bg-transparent text-xs font-medium text-ink-base focus:outline-none"
      />
    );
  }

  // 非編集モード: セル名（未設定ならプレースホルダー）をボタンとして表示し、
  // ダブルクリックで編集モードへ入る。
  return (
    <button
      type="button"
      onDoubleClick={() => {
        setDraft(name ?? '');
        setEditing(true);
      }}
      title="Double-click to rename"
      className={cn(
        // pr-0.5: `truncate` clips at the padding edge, and the final italic
        // glyph of the placeholder leans past its advance width — give the
        // overhang room so "Untitled cell" doesn't lose the tip of its "l".
        'truncate pr-0.5 text-xs font-medium',
        name ? 'text-ink-base' : 'text-ink-subtle italic',
      )}
    >
      {name || 'Untitled cell'}
    </button>
  );
}

/**
 * LIMIT auto-append toggle + inline editable value (design.md §5).
 * SQL セル用の LIMIT 自動付与トグルと、LIMIT 値をインライン編集できるコントロール。
 *
 * @param autoLimit - LIMIT を自動付与するかどうか（トグルの ON/OFF 状態）。
 * @param limit - 現在の LIMIT 値。
 * @param onToggle - LIMIT ラベルをクリックしてトグルを切り替えたときに呼ばれる。
 * @param onLimitChange - LIMIT 値の編集が確定したときに、新しい数値を渡して呼ばれる。
 */
function LimitControl({
  autoLimit,
  limit,
  onToggle,
  onLimitChange,
}: {
  autoLimit: boolean;
  limit: number;
  onToggle?: () => void;
  onLimitChange?: (limit: number) => void;
}) {
  // editing: LIMIT 値の編集モード中かどうか。
  const [editing, setEditing] = useState(false);
  // draft: 編集中の LIMIT 値（文字列のまま保持し、確定時に数値へ変換する）。
  const [draft, setDraft] = useState(String(limit));

  // 編集内容を確定する処理: 正の有限数としてパースできれば親へ通知し、
  // そうでなければ編集前の値に戻す（不正な入力を破棄する）。
  const commit = () => {
    setEditing(false);
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed) && parsed > 0) onLimitChange?.(parsed);
    else setDraft(String(limit));
  };

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-2xs',
        autoLimit
          ? 'border-border-base bg-surface-inset text-ink-muted'
          : 'border-transparent text-ink-subtle',
      )}
    >
      {/* "LIMIT" ラベル自体がトグルスイッチを兼ねる（クリックで自動付与の ON/OFF を切り替え）。 */}
      <button
        type="button"
        role="switch"
        aria-checked={autoLimit}
        aria-label="Toggle auto LIMIT"
        onClick={onToggle}
        className="font-semibold tracking-wide uppercase hover:text-ink-strong"
      >
        LIMIT
      </button>
      {editing ? (
        // 編集モード: 数字のみ許容する入力欄を表示する。
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              // Escape: 編集内容を破棄して元の LIMIT 値に戻す。
              setDraft(String(limit));
              setEditing(false);
            }
          }}
          aria-label="LIMIT value"
          className="w-14 bg-transparent tabular-nums focus:outline-none"
        />
      ) : (
        // 非編集モード: 現在の LIMIT 値を表示するボタン。クリックで編集モードへ入る。
        // 自動付与が OFF のときは取り消し線で「値は設定されているが適用されない」ことを示す。
        <button
          type="button"
          aria-label="Edit LIMIT value"
          onClick={() => {
            setDraft(String(limit));
            setEditing(true);
          }}
          className={cn('tabular-nums hover:text-ink-strong', !autoLimit && 'line-through')}
        >
          {limit.toLocaleString('en-US')}
        </button>
      )}
    </div>
  );
}

/**
 * TopBar に表示するノートブックタブ列コンポーネント。
 * 開いているノートブックをタブとして横に並べ、選択、クローズ、新規作成、
 * ダブルクリックによるインライン名前変更を提供する。実際の状態変更（開閉や改名など）は
 * すべて呼び出し元（TopBar）から渡されるコールバックで行い、このファイル自身は
 * ローカルな編集中状態（インライン編集の入力値など）だけを持つ。
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../../utils/cn';

/** 1つのノートブックタブが表示に必要とする最小限の情報。 */
export interface NotebookTab {
  /** ノートブックの一意なID。 */
  id: string;
  /** タブに表示するノートブック名。 */
  name: string;
  /** 未保存の変更があるかどうか（true の場合はドット表示される）。 */
  dirty: boolean;
}

/**
 * Notebook tabs in the TopBar (design.md §6, §5 管理). Each tab selects its
 * notebook, shows a dirty dot when unsaved, closes via the × (the caller
 * confirms for dirty tabs), and renames inline on double-click. The active tab
 * carries the accent underline.
 */
/**
 * ノートブックタブ列本体。渡された `tabs` をそのまま横並びに描画し、
 * クリック、クローズ、改名、新規タブ追加の各操作を対応するコールバックに委譲する。
 *
 * @param tabs - 表示するタブの一覧。
 * @param activeId - 現在アクティブなタブのID（null の場合はどれも選択されていない）。
 * @param onSelect - タブがクリックされたときに呼ばれる（タブ切り替え）。
 * @param onClose - タブの × ボタンが押されたときに呼ばれる（未保存の場合の確認は呼び出し元が行う）。
 * @param onRename - インライン編集でタブ名が確定したときに呼ばれる。
 * @param onNew - 「新規ノートブック」ボタンが押されたときに呼ばれる。
 */
export function NotebookTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onRename,
  onNew,
}: {
  tabs: NotebookTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex items-stretch gap-1">
      {/* 開いているノートブックの数だけタブを描画する。 */}
      {tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
          onRename={(name) => onRename(tab.id, name)}
        />
      ))}
      {/* 新規ノートブックを作成するための「+」ボタン。 */}
      <button
        type="button"
        aria-label="New notebook"
        onClick={onNew}
        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink-strong"
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

/**
 * タブ1件分の表示と操作を担う内部コンポーネント（export しない）。
 * ダブルクリックで名前のインライン編集に切り替わり、Enter/フォーカス外れで確定、
 * Escape で編集前の値に戻してキャンセルする。
 *
 * @param tab - このタブが表す情報（id / name / dirty）。
 * @param active - このタブが現在アクティブかどうか。
 * @param onSelect - タブ本体クリック時に呼ばれる。
 * @param onClose - × ボタン押下時に呼ばれる。
 * @param onRename - インライン編集で新しい名前が確定したときに呼ばれる。
 */
function TabItem({
  tab,
  active,
  onSelect,
  onClose,
  onRename,
}: {
  tab: NotebookTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  // インライン編集中かどうか。true の間は input を表示する。
  const [editing, setEditing] = useState(false);
  // インライン編集中の入力値（確定するまでは tab.name とは別に保持する）。
  const [draft, setDraft] = useState(tab.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // 編集モードに入った瞬間に input へフォーカスし、既存の文字列を全選択しておく
  // （そのまま打ち直せば全文置き換えできるようにするため）。
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // 編集内容を確定する。前後の空白を除去し、空文字や変更なしの場合は onRename を呼ばない。
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== tab.name) onRename(trimmed);
  };

  return (
    <div
      className={cn(
        'group relative flex h-8 items-center gap-2 rounded-md border px-2.5 transition-colors',
        active
          ? 'border-border-base bg-surface-raised text-ink-strong shadow-sm'
          : 'border-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink-base',
      )}
    >
      {/* 未保存の変更があるノートブックにだけ表示するドットインジケーター。 */}
      {tab.dirty && (
        <span
          aria-label="Unsaved changes"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
      )}
      {/* 編集中は名前入力欄、それ以外はタブ名ボタン（クリックで選択、ダブルクリックで編集開始）を出し分ける。 */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="Rename notebook"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(tab.name);
              setEditing(false);
            }
          }}
          className="w-32 bg-transparent text-sm font-medium focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => {
            setDraft(tab.name);
            setEditing(true);
          }}
          className="max-w-[10rem] truncate text-sm font-medium"
          title={`${tab.name}${tab.dirty ? ' • unsaved' : ''} (double-click to rename)`}
        >
          {tab.name}
        </button>
      )}
      {/* タブを閉じるボタン。未保存の場合の確認ダイアログ表示は呼び出し元（TopBar）の責務。 */}
      <button
        type="button"
        aria-label={`Close ${tab.name}`}
        onClick={onClose}
        className={cn(
          'rounded-sm p-0.5 text-ink-subtle transition-opacity hover:text-ink-strong',
          active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60',
        )}
      >
        <X size={13} strokeWidth={2} />
      </button>
      {/* アクティブなタブの下端に表示するアクセントの下線。 */}
      {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
    </div>
  );
}

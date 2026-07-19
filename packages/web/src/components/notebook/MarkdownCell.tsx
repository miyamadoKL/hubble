/**
 * MarkdownCell.tsx
 *
 * Notebook 内の Markdown セルの本体表示部分。プレビュー表示（Markdown コンポーネント
 * によるレンダリング結果）と、編集用のテキストエリアを状態に応じて切り替える。
 * SQL セル（SqlCell.tsx、担当外）と並んでノートブックのセルリストに並ぶ。
 */
import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { notebookMessages } from '../../i18n/messages/notebook';

/**
 * A markdown cell body (P4a §2). Renders the markdown preview;
 * clicking it (or pressing the edit button) swaps in a mono textarea. Blur or
 * Ctrl/Cmd+Enter commits and returns to the rendered view.
 *
 * The editor is a separate component mounted only while editing, so its draft
 * state initialises from `source` on mount — no setState-in-effect needed.
 */
/**
 * Markdown セルの表示/編集を切り替えるコンテナ。編集状態は親（ノートブック側の
 * ストア）が持ち、このコンポーネント自身は `editing` フラグに従って描画を出し分ける
 * だけの制御コンポーネント。
 *
 * @param source - セルの Markdown ソース文字列。
 * @param editing - true のとき編集用テキストエリアを表示する。
 * @param onStartEdit - プレビューをクリックして編集モードへ入るときに呼ばれる。
 * @param onChange - 編集内容が確定するタイミングで新しいソース文字列を親へ通知する。
 * @param onCommit - 編集モードを終了してプレビュー表示へ戻すことを親へ伝える。
 */
export function MarkdownCell({
  source,
  editing,
  onStartEdit,
  onChange,
  onCommit,
}: {
  source: string;
  editing: boolean;
  onStartEdit: () => void;
  onChange: (next: string) => void;
  onCommit: () => void;
}) {
  const t = useT(notebookMessages);
  // 編集中は専用のテキストエリアコンポーネントへ切り替える。
  if (editing) {
    return <MarkdownEditor source={source} onChange={onChange} onCommit={onCommit} />;
  }
  // 非編集時: プレビュー表示。ソースが空ならプレースホルダー文言を出す。
  return (
    <button
      type="button"
      onClick={onStartEdit}
      aria-label={t('editMarkdownAria')}
      className="block w-full cursor-text bg-surface-raised px-5 py-4 text-left"
    >
      {source.trim() ? (
        <Markdown source={source} />
      ) : (
        <span className="text-sm text-ink-subtle italic">{t('emptyMarkdownPlaceholder')}</span>
      )}
    </button>
  );
}

/**
 * Markdown ソースを編集するためのテキストエリア。マウント時にのみ `source` から
 * draft の初期値を作る（コメントにある通り setState-in-effect を避けるため、
 * MarkdownCell が editing フラグに応じて本コンポーネントを都度マウント/アンマウントする設計）。
 *
 * @param source - 編集開始時点の Markdown ソース文字列（draft の初期値になる）。
 * @param onChange - 編集内容が確定したとき（blur / Ctrl+Enter）に新しいソースを渡して呼ばれる。
 * @param onCommit - 編集モードを終了してプレビュー表示へ戻すことを親へ伝える。
 */
function MarkdownEditor({
  source,
  onChange,
  onCommit,
}: {
  source: string;
  onChange: (next: string) => void;
  onCommit: () => void;
}) {
  const t = useT(notebookMessages);
  // draft: 編集中の Markdown ソース（未確定の下書き）。mount 時の source を初期値にする。
  const [draft, setDraft] = useState(source);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus + place the caret at the end on mount (external DOM sync, not state).
  // マウント時にテキストエリアへフォーカスし、カーソルを末尾へ移動する。
  // また textarea の高さをコンテンツに合わせて自動調整する（DOM への直接操作であり state ではない）。
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // 編集内容を確定する処理: draft を親へ通知し、編集モードの終了を伝える。
  const commit = () => {
    onChange(draft);
    onCommit();
  };

  return (
    <div className="bg-surface-raised px-5 py-4">
      <textarea
        ref={textareaRef}
        value={draft}
        aria-label={t('markdownSourceAria')}
        onChange={(e) => {
          // 入力のたびに draft を更新し、textarea の高さもコンテンツに合わせて再計算する
          // （オートリサイズ: 一旦 auto に戻してから scrollHeight を測ることで縮小にも対応）。
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            // Ctrl/Cmd+Enter: デフォルトの改行動作を止めて編集内容を確定する。
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            // Escape: 編集内容を破棄して元のソースに戻し、プレビュー表示へ戻る。
            setDraft(source);
            onCommit();
          }
        }}
        rows={3}
        className={cn(
          'w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-ink-base',
          'placeholder:text-ink-subtle focus:outline-none',
        )}
        placeholder={t('markdownEditorPlaceholder')}
      />
    </div>
  );
}

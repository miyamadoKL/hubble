// PresentationView コンポーネント
// ノートブックをスライドショー風に閲覧するための「プレゼンテーションモード」の
// 画面全体を担当する。アクティブなノートブックのセル群を `-- heading` コメントの
// 区切りでカード（スライド）に分割し、読み取り専用のフルスクリーン表示で見せる。
import { X } from 'lucide-react';
import { SqlCode } from './SqlCode';
import { Markdown } from './Markdown';
import { EmptyState } from '../common/EmptyState';
import { Presentation } from 'lucide-react';
import { useActiveNotebook } from '../../notebook';
import { toPresentationCards } from '../../notebook/presentation';
import { useUiStore } from '../../stores/uiStore';

/**
 * Presentation mode (design.md §5 stretch). A read-only, full-bleed view of the
 * active notebook's cells, split into titled cards on `--` comment headings.
 * Toggled by Ctrl/Cmd+Shift+P or the command palette; Escape exits.
 */
/**
 * プレゼンテーションモードの画面（design.md §5 stretch）。
 * 現在アクティブなノートブックのセルを読み取り専用のフルブリード表示に変換し、
 * `--` コメント見出しを区切りとしてタイトル付きのカード（スライド）に分割する。
 * Ctrl/Cmd+Shift+P またはコマンドパレットから切り替え、Escape で終了する。
 * このコンポーネント自体は props を受け取らない（現在のアクティブノートブックを
 * ストアから直接参照する）。
 */
export function PresentationView() {
  // 現在アクティブなノートブックのエントリ（ノートブック本体とメタ情報）を取得。
  const entry = useActiveNotebook();
  // 「Exit」ボタン押下時のハンドラー: UIストアのプレゼンテーション表示フラグをトグルして閉じる。
  const close = () => useUiStore.getState().togglePresentation();
  // ノートブックのセル群を、見出しコメントで区切られたカード配列に変換する。
  // アクティブなノートブックがなければ空配列。
  const cards = entry ? toPresentationCards(entry.notebook) : [];

  return (
    <div className="fixed inset-0 z-[80] overflow-auto bg-surface-base" data-testid="presentation-view">
      {/* ヘッダー: 上部に固定表示され、ノートブック名とExitボタンを表示する。 */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border-base bg-surface-base/95 px-8 py-4 backdrop-blur">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-2xs font-semibold tracking-[0.14em] text-accent uppercase">
            <Presentation size={13} strokeWidth={2} />
            Presentation
          </p>
          {/* ノートブック名。存在しない場合は "Untitled notebook" を表示。 */}
          <h1 className="truncate text-xl font-semibold text-ink-strong">
            {entry?.notebook.name ?? 'Untitled notebook'}
          </h1>
        </div>
        {/* プレゼンテーションモードを終了するボタン。 */}
        <button
          type="button"
          onClick={close}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-base bg-surface-raised px-3 py-1.5 text-sm text-ink-muted hover:border-accent/40 hover:text-accent"
        >
          <X size={15} strokeWidth={2} />
          Exit
        </button>
      </header>

      <div className="mx-auto w-full max-w-4xl px-8 py-8">
        {/* カードが1枚も無い場合（見出しコメントもMarkdownセルも無い場合）は空状態を表示。 */}
        {cards.length === 0 ? (
          <EmptyState
            icon={Presentation}
            title="Nothing to present"
            description="Add SQL with `-- heading` comments or Markdown cells to build slides."
          />
        ) : (
          // カードの一覧を縦に並べてレンダリングする。
          <div className="flex flex-col gap-6">
            {cards.map((card, i) => (
              <article
                key={i}
                className="overflow-hidden rounded-lg border border-border-base bg-surface-raised shadow-sm"
              >
                {/* カードのタイトル（見出しコメントから抽出したもの）があれば表示。 */}
                {card.title && (
                  <h2 className="border-b border-border-subtle px-5 py-3 text-base font-semibold text-ink-strong">
                    {card.title}
                  </h2>
                )}
                <div className="px-5 py-4">
                  {/* カードの種類に応じて Markdown レンダラーか SQL シンタックスハイライトを出し分ける。 */}
                  {card.kind === 'markdown' ? (
                    <Markdown source={card.body} />
                  ) : (
                    <SqlCode source={card.body} />
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

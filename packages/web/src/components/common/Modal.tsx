/**
 * 画面中央にオーバーレイ表示するモーダルダイアログコンポーネント。
 * 背景に半透明のスクリム(暗幕)を敷き、Escape キー押下または
 * 背景クリックのいずれでも閉じられるようにする。
 * タイトル、説明文、本文(children)、フッターをそれぞれ差し込める汎用的な構造を持つ。
 */
import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { IconButton } from './IconButton';

/**
 * Modal コンポーネントの props。
 */
interface ModalProps {
  /** モーダルを表示するかどうか。false の場合は何も描画しない。 */
  open: boolean;
  /** モーダルを閉じる際に呼ばれるコールバック(Escape キーや背景クリック、閉じるボタンから呼ばれる)。 */
  onClose: () => void;
  /** ヘッダーに表示するタイトル文字列。aria-label にも使用される。 */
  title: string;
  /** タイトル下に表示する補足説明文(省略可)。 */
  description?: string;
  /** モーダル本文として表示する内容(省略可)。 */
  children?: ReactNode;
  /** フッター領域に表示する内容(ボタン群など、省略可)。 */
  footer?: ReactNode;
  /** モーダル本体(カード部分)に追加で当てる Tailwind クラス名。 */
  className?: string;
}

/** Centered modal dialog with scrim. Closes on Escape and backdrop click. */
/**
 * 画面中央に表示するモーダルダイアログ。
 * `open` が false の間は何も描画しない。表示中は Escape キー押下や
 * 背景(スクリム)クリック、右上の閉じるボタンのいずれでも `onClose` が呼ばれる。
 *
 * @param open モーダルの表示/非表示。
 * @param onClose 閉じる操作が行われたときに呼ばれるコールバック。
 * @param title ヘッダーに表示するタイトル。
 * @param description タイトル下に表示する補足説明(任意)。
 * @param children モーダル本文の内容(任意)。
 * @param footer フッターに表示する内容(任意)。
 * @param className モーダル本体に追加するクラス名(任意)。
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: ModalProps) {
  // Escape キーでモーダルを閉じるためのグローバルキーイベントを登録する。
  // open が false のときは何もせず、開いている間だけリスナーを張る。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // クリーンアップ: モーダルが閉じられる、または再レンダリング時にリスナーを解除する
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 非表示状態の場合は DOM に何も出力しない(早期リターン)
  if (!open) return null;

  return (
    // 画面全体を覆い、モーダルを中央揃えで配置するコンテナ
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* 背景のスクリム(半透明の暗幕)。クリックすると onClose が呼ばれる */}
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-strong/40 animate-[fadeIn_150ms_ease-out]"
      />
      {/* モーダル本体のカード部分 */}
      <div
        className={cn(
          'relative z-10 w-full max-w-lg rounded-lg border border-border-strong bg-surface-overlay shadow-lg',
          'animate-[fadeIn_150ms_ease-out]',
          className,
        )}
      >
        {/* ヘッダー: タイトル、説明文、閉じるボタンをまとめて表示 */}
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-strong">{title}</h2>
            {/* description が渡されている場合のみ補足説明を表示する */}
            {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} tooltip={false} />
        </header>
        {/* children が渡されている場合のみ本文領域を表示する */}
        {children && <div className="px-5 py-4">{children}</div>}
        {/* footer が渡されている場合のみフッター領域を表示する */}
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

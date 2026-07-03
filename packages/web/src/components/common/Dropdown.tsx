/**
 * カスタムドロップダウン（セレクト）コンポーネント。
 *
 * ネイティブの <select> 要素の代わりに、アプリ独自のテーマに沿ってスタイリングした
 * トリガーボタンと選択肢メニューを描画する。外側クリックと Escape キーでの
 * クローズや、矢印キーによる選択肢のフォーカス移動にも対応する。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

/** ドロップダウンの1つの選択肢を表す。 */
export interface DropdownOption<T extends string> {
  /** 選択肢の値（onChange 等でやり取りされる実際の値）。 */
  value: T;
  /** 画面に表示するラベル文字列。 */
  label: string;
  /** ラベルの横に補助的に表示する短いヒント文字列（任意）。 */
  hint?: string;
}

/** Dropdown コンポーネントに渡す props。 */
interface DropdownProps<T extends string> {
  /** 現在選択されている値。 */
  value: T;
  /** 選択肢の一覧。 */
  options: DropdownOption<T>[];
  /** 選択肢が変更されたときに呼ばれるコールバック。 */
  onChange: (value: T) => void;
  /** Optional leading element (icon / label) rendered inside the trigger. */
  /** トリガー（ボタン）内部の先頭に表示する任意の要素（アイコンやラベルなど）。 */
  leading?: ReactNode;
  /** ルート要素に付与する追加の className。 */
  className?: string;
  /** メニュー（選択肢リスト）要素に付与する追加の className。 */
  menuClassName?: string;
  /** トリガーボタンに設定する aria-label。 */
  ariaLabel?: string;
  /** メニューの表示位置の左右揃え（'start': 左寄せ, 'end': 右寄せ）。 */
  align?: 'start' | 'end';
  /** Borderless trigger for embedding inside another bordered control. */
  /** 枠線なしのトリガー表示にする場合は true（他の枠付きコントロールの中に埋め込む用途）。 */
  bare?: boolean;
}

/**
 * Custom dropdown/select — styled to the instrument theme rather than the
 * native control. Closes on outside click and Escape; basic arrow-key nav.
 *
 * カスタムのドロップダウン（セレクト）コンポーネント。ネイティブの <select> ではなく
 * 独自にスタイリングしたリストで選択肢を表示する。外側クリックまたは Escape キーで
 * メニューを閉じ、矢印キーによる簡易的な選択肢の移動にも対応する。
 *
 * @typeParam T - 選択肢の値として使う文字列リテラル型
 * @param props - DropdownProps（value, options, onChange, leading, className 等）
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  leading,
  className,
  menuClassName,
  ariaLabel,
  align = 'start',
  bare = false,
}: DropdownProps<T>) {
  // メニュー（選択肢リスト）が開いているかどうかの状態。
  const [open, setOpen] = useState(false);
  // キーボード操作でフォーカスされている選択肢のインデックス。
  const [activeIndex, setActiveIndex] = useState(0);
  // 外側クリック判定に使うルート要素への参照。
  const rootRef = useRef<HTMLDivElement>(null);
  // 現在の value に対応する選択肢オブジェクト（表示ラベルの取得に使用）。
  const selected = options.find((o) => o.value === value);

  // メニューが開いている間だけ、外側クリックを検知してメニューを閉じるリスナーを登録する。
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      // クリック位置がルート要素の外側であればメニューを閉じる。
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    // クリーンアップ: メニューが閉じられたか、コンポーネントがアンマウントされた際にリスナーを解除する。
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // メニューを開く処理。
  function openMenu() {
    // Highlight the currently-selected option when the menu opens.
    // 現在選択中の値に対応するインデックスをアクティブにしてからメニューを開く。
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }

  // 指定したインデックスの選択肢を確定する処理。
  function commit(index: number) {
    const opt = options[index];
    if (opt) {
      // onChange で親に選択値を通知してからメニューを閉じる。
      onChange(opt.value);
      setOpen(false);
    }
  }

  // トリガー/メニューに対するキーボード操作のハンドラー。
  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      // メニューが閉じている状態で Enter、Space、下矢印が押された場合はメニューを開く。
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    // メニューが開いている場合の各キー操作を処理する。
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      // アクティブな選択肢を1つ下に移動する（末尾を超えない）。
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      // アクティブな選択肢を1つ上に移動する（先頭を下回らない）。
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      // アクティブな選択肢を確定する。
      e.preventDefault();
      commit(activeIndex);
    }
  }

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      {/* トリガーボタン: クリックまたはキーボード操作でメニューの開閉を切り替える */}
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={cn(
          'inline-flex h-8 w-full items-center gap-1.5 px-2.5 text-sm text-ink-base transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          bare
            ? 'rounded-sm hover:bg-surface-sunken'
            : 'rounded-md border border-border-base bg-surface-raised hover:bg-surface-sunken',
          !bare && open && 'border-accent ring-1 ring-accent/30',
        )}
      >
        {/* leading 要素（任意のアイコン等）と、現在選択中のラベルを表示する */}
        {leading}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? value}</span>
        {/* メニューの開閉状態を示すシェブロンアイコン（開いているときは反転させる） */}
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      {/* メニューが開いている場合のみ、選択肢一覧を表示する */}
      {open && (
        <ul
          role="listbox"
          className={cn(
            'absolute top-full z-50 mt-1 max-h-72 min-w-full overflow-auto rounded-md border border-border-strong',
            'bg-surface-overlay p-1 shadow-lg',
            'animate-[fadeIn_150ms_ease-out]',
            align === 'end' ? 'right-0' : 'left-0',
            menuClassName,
          )}
        >
          {/* options を1件ずつ選択肢ボタンとして描画する */}
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === activeIndex;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                    isActive ? 'bg-accent-soft text-accent' : 'text-ink-base',
                  )}
                >
                  {/* 選択中の項目にのみチェックマークを表示する（未選択時は透明にして幅だけ確保） */}
                  <Check
                    size={14}
                    strokeWidth={2}
                    className={cn('shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {/* hint が指定されている場合のみ、補足テキストを右側に表示する */}
                  {opt.hint && (
                    <span className="shrink-0 font-mono text-2xs text-ink-subtle">{opt.hint}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

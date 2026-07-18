/**
 * サイドバーパネル等に組み込むためのコンパクトな検索入力フィールド。
 * 左側に検索アイコン、右側に入力値がある場合のみクリアボタンを表示する。
 * 制御コンポーネントとして `value` / `onChange` で値を親から管理する設計になっている。
 */
import { Search, X } from 'lucide-react';
import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '../../utils/cn';

/**
 * SearchInput コンポーネントの props。
 * `InputHTMLAttributes` を継承しつつ、`onChange` は文字列を直接受け取る形に上書きしている。
 */
interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  /** 入力欄の現在値(制御コンポーネントとして親が保持する)。 */
  value: string;
  /** 入力値が変化したときに呼ばれるコールバック。変更後の文字列を受け取る。 */
  onChange: (value: string) => void;
  /** クリアボタン押下時に追加で呼ばれるコールバック(省略可)。 */
  onClear?: () => void;
  /** 内部の `<input>` 要素に転送する ref。プログラムからフォーカスを当てる場合などに使う。 */
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * サイドバーパネル向けのコンパクトな検索入力フィールド。
 * 検索アイコンを常に表示し、`value` が空でないときのみクリアボタンを表示する。
 *
 * @param value 入力欄の現在値。
 * @param onChange 値の変更を親に通知するコールバック。
 * @param onClear クリアボタン押下時に呼ばれる追加コールバック(任意)。
 * @param placeholder プレースホルダー文字列(デフォルトは 'Search…')。
 * @param className ルート要素に追加するクラス名(任意)。
 * @param inputRef 内部 input 要素への ref(任意)。
 * @param rest その他の input 属性はそのまま `<input>` に渡される。
 */
export function SearchInput({
  value,
  onChange,
  onClear,
  placeholder = 'Search…',
  className,
  inputRef,
  ...rest
}: SearchInputProps) {
  return (
    // 検索アイコン、入力欄、クリアボタンを横に並べる枠。フォーカス時に枠線をハイライトする
    <div
      className={cn(
        'group flex h-8 items-center gap-2 rounded-md border border-border-base bg-surface-raised px-2',
        'focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30',
        className,
      )}
    >
      {/* 検索であることを示すアイコン(常に表示) */}
      <Search size={14} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
      {/* 実際のテキスト入力欄。値の変更はそのまま onChange で親に伝える(制御コンポーネント) */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink-base placeholder:text-ink-subtle focus:outline-none"
        {...rest}
      />
      {/* 入力値がある場合のみクリアボタンを表示する */}
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            // 値を空文字にリセットし、任意で親のクリア処理も呼び出す
            onChange('');
            onClear?.();
          }}
          className="shrink-0 rounded-sm p-0.5 text-ink-subtle hover:text-ink-strong"
        >
          <X size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

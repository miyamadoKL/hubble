/**
 * キーボードショートカットを表示するための小さな「チップ」群を描画するコンポーネント。
 * 例えば `["Ctrl", "K"]` のようなキーの配列を渡すと、各キーが個別の
 * `<kbd>` 要素として等幅フォントのバッジ風スタイルで並んで表示される。
 * ツールチップやヘルプ表示など、ショートカットキーの案内を行う箇所で利用する。
 */
import { cn } from '../../utils/cn';

/**
 * Kbd コンポーネントの props。
 */
interface KbdProps {
  /** 表示するキーの並び。例: `["Ctrl", "K"]` は「Ctrl」「K」の2つのチップとして描画される。 */
  keys: string[];
  /** ルート要素 (span) に追加で当てる Tailwind クラス名。 */
  className?: string;
}

/**
 * キーボードショートカットのチップ群を表示するコンポーネント。
 * `keys` 配列の各要素を 1 つの `<kbd>` バッジとして横並びに描画する。
 *
 * @param keys 表示するキー名の配列(例: `["Ctrl", "K"]`)。
 * @param className ルート要素に付与する追加クラス名。
 */
export function Kbd({ keys, className }: KbdProps) {
  return (
    // 各キーチップを横に並べるためのコンテナ(gap で間隔を調整)
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {/* keys 配列を1つずつ <kbd> バッジとして描画する */}
      {keys.map((key) => (
        <kbd
          key={key}
          className={cn(
            'inline-flex min-w-[1.25rem] items-center justify-center rounded-xs border border-border-base',
            'bg-surface-inset px-1 py-0.5 font-mono text-2xs leading-none text-ink-muted',
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

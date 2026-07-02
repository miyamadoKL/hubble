/**
 * TopBar の左端に表示するプロダクトロゴ（テキストロゴ）コンポーネント。
 * "Hubble" のワードマークと "Workbench" ラベルを縦の区切り線とともに並べるだけの
 * 見た目専用コンポーネントで、状態やロジックは持たない。
 */
import { cn } from '../../utils/cn';

/**
 * Text logo "Hubble" (design.md §6: テキストロゴ, 文字組で個性を出す).
 * Memorable detail: of the wordmark's two `b`s, the first carries the copper
 * accent — a single accented letter set in mono with tightened tracking, beside
 * the product label. No Hue/Cloudera/Trino marks.
 */
/**
 * "Hubble" のテキストロゴを描画する。
 * ワードマーク中の2つの `b` のうち最初の1文字だけアクセントカラーを当てることで、
 * ロゴマークを使わずに個性を出している（design.md §6 の「記憶に残るディテール」）。
 *
 * @param className - ルート要素に追加する Tailwind クラス（配置調整用）。
 */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-baseline gap-2 select-none', className)}>
      {/* ワードマーク本体。2文字目の "b" だけアクセントカラーにして視線を引く。 */}
      <span className="font-mono text-xl leading-none font-semibold tracking-[-0.04em] text-ink-strong">
        Hu<span className="text-accent">b</span>ble
      </span>
      {/* ロゴとプロダクトラベルを分ける縦の区切り線（装飾のみなので aria-hidden）。 */}
      <span className="h-3.5 w-px bg-border-strong" aria-hidden />
      {/* サブラベル。プロダクトの種類（Workbench）を示す。 */}
      <span className="text-2xs font-medium tracking-[0.18em] text-ink-subtle uppercase">
        Workbench
      </span>
    </div>
  );
}

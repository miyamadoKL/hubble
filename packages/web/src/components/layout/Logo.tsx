import { cn } from '../../utils/cn';

/**
 * Text logo "Hubble" (design.md §6: テキストロゴ, 文字組で個性を出す).
 * Memorable detail: of the wordmark's two `b`s, the first carries the copper
 * accent — a single accented letter set in mono with tightened tracking, beside
 * the product label. No Hue/Cloudera/Trino marks.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-baseline gap-2 select-none', className)}>
      <span className="font-mono text-xl leading-none font-semibold tracking-[-0.04em] text-ink-strong">
        Hu<span className="text-accent">b</span>ble
      </span>
      <span className="h-3.5 w-px bg-border-strong" aria-hidden />
      <span className="text-2xs font-medium tracking-[0.18em] text-ink-subtle uppercase">
        Workbench
      </span>
    </div>
  );
}

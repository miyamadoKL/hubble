import { cn } from '../../utils/cn';

interface KbdProps {
  keys: string[];
  className?: string;
}

/** Keyboard shortcut chips, e.g. `["Ctrl", "K"]`. Mono, instrument-styled. */
export function Kbd({ keys, className }: KbdProps) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
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

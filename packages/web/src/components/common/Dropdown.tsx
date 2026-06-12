import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

interface DropdownProps<T extends string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Optional leading element (icon / label) rendered inside the trigger. */
  leading?: ReactNode;
  className?: string;
  menuClassName?: string;
  ariaLabel?: string;
  align?: 'start' | 'end';
  /** Borderless trigger for embedding inside another bordered control. */
  bare?: boolean;
}

/**
 * Custom dropdown/select — styled to the instrument theme rather than the
 * native control. Closes on outside click and Escape; basic arrow-key nav.
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
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function openMenu() {
    // Highlight the currently-selected option when the menu opens.
    setActiveIndex(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function commit(index: number) {
    const opt = options[index];
    if (opt) {
      onChange(opt.value);
      setOpen(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeIndex);
    }
  }

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
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
        {leading}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? value}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
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
                  <Check
                    size={14}
                    strokeWidth={2}
                    className={cn('shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {opt.hint && <span className="shrink-0 font-mono text-2xs text-ink-subtle">{opt.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

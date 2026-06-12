import { Search, X } from 'lucide-react';
import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '../../utils/cn';

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  /** Forwarded to the underlying input (e.g. for programmatic focus). */
  inputRef?: Ref<HTMLInputElement>;
}

/** Compact search field for sidebar panels (design.md §5: 検索フィルタ). */
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
    <div
      className={cn(
        'group flex h-8 items-center gap-2 rounded-md border border-border-base bg-surface-raised px-2',
        'focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30',
        className,
      )}
    >
      <Search size={14} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink-base placeholder:text-ink-subtle focus:outline-none"
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
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

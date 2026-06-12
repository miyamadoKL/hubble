import { Variable as VariableIcon } from 'lucide-react';
import type { Variable } from '@hubble/contracts';
import { cn } from '../../utils/cn';

/**
 * Variable substitution panel (design.md §5 変数パネル; shown only when the
 * notebook's SQL defines `${…}` variables). Each variable renders a typed input
 * (text / number / date / datetime-local / checkbox / select) seeded from its
 * detected default. Ctrl/Cmd+Enter from any input runs the active cell.
 */
export function VariablePanel({
  variables,
  onChange,
  onRunActive,
}: {
  variables: Variable[];
  onChange: (name: string, value: string) => void;
  onRunActive: () => void;
}) {
  if (variables.length === 0) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRunActive();
    }
  };

  return (
    <section
      aria-label="Notebook variables"
      data-testid="variable-panel"
      className="mb-4 rounded-lg border border-border-base bg-surface-raised shadow-sm"
    >
      <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
        <VariableIcon size={14} strokeWidth={1.75} className="text-accent" />
        <h2 className="text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
          Variables
        </h2>
        <span className="font-mono text-2xs text-ink-subtle">
          {variables.length} parameter{variables.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
        {variables.map((v) => (
          <VariableField key={v.name} variable={v} onChange={onChange} onKeyDown={onKeyDown} />
        ))}
      </div>
    </section>
  );
}

const INPUT_CLASS =
  'w-full rounded-md border border-border-base bg-surface-base px-2.5 py-1.5 text-sm text-ink-strong ' +
  'placeholder:text-ink-subtle focus:border-accent focus:outline-none';

function VariableField({
  variable,
  onChange,
  onKeyDown,
}: {
  variable: Variable;
  onChange: (name: string, value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const { name, value, meta } = variable;
  const inputId = `var-${name}`;
  const set = (next: string) => onChange(name, next);

  return (
    <label htmlFor={inputId} className="flex flex-col gap-1">
      <span className="font-mono text-2xs font-medium tracking-wide text-ink-muted">${name}</span>
      {meta.type === 'select' && meta.options ? (
        <select
          id={inputId}
          value={value}
          onChange={(e) => set(e.target.value)}
          onKeyDown={onKeyDown}
          className={INPUT_CLASS}
        >
          {meta.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : meta.type === 'checkbox' ? (
        <span className="flex h-[34px] items-center">
          <input
            id={inputId}
            type="checkbox"
            checked={value === 'true'}
            onChange={(e) => set(e.target.checked ? 'true' : 'false')}
            onKeyDown={onKeyDown}
            className={cn('h-4 w-4 cursor-pointer accent-accent')}
          />
        </span>
      ) : (
        <input
          id={inputId}
          type={meta.type === 'text' ? 'text' : meta.type}
          value={value}
          placeholder={meta.placeholder}
          onChange={(e) => set(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(INPUT_CLASS, meta.type === 'number' && 'tabular-nums')}
        />
      )}
    </label>
  );
}

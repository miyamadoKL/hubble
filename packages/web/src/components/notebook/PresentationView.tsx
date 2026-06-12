import { X } from 'lucide-react';
import { SqlCode } from './SqlCode';
import { Markdown } from './Markdown';
import { EmptyState } from '../common/EmptyState';
import { Presentation } from 'lucide-react';
import { useActiveNotebook } from '../../notebook';
import { toPresentationCards } from '../../notebook/presentation';
import { useUiStore } from '../../stores/uiStore';

/**
 * Presentation mode (design.md §5 stretch). A read-only, full-bleed view of the
 * active notebook's cells, split into titled cards on `--` comment headings.
 * Toggled by Ctrl/Cmd+Shift+P or the command palette; Escape exits.
 */
export function PresentationView() {
  const entry = useActiveNotebook();
  const close = () => useUiStore.getState().togglePresentation();
  const cards = entry ? toPresentationCards(entry.notebook) : [];

  return (
    <div className="fixed inset-0 z-[80] overflow-auto bg-surface-base" data-testid="presentation-view">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border-base bg-surface-base/95 px-8 py-4 backdrop-blur">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-2xs font-semibold tracking-[0.14em] text-accent uppercase">
            <Presentation size={13} strokeWidth={2} />
            Presentation
          </p>
          <h1 className="truncate text-xl font-semibold text-ink-strong">
            {entry?.notebook.name ?? 'Untitled notebook'}
          </h1>
        </div>
        <button
          type="button"
          onClick={close}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-base bg-surface-raised px-3 py-1.5 text-sm text-ink-muted hover:border-accent/40 hover:text-accent"
        >
          <X size={15} strokeWidth={2} />
          Exit
        </button>
      </header>

      <div className="mx-auto w-full max-w-4xl px-8 py-8">
        {cards.length === 0 ? (
          <EmptyState
            icon={Presentation}
            title="Nothing to present"
            description="Add SQL with `-- heading` comments or Markdown cells to build slides."
          />
        ) : (
          <div className="flex flex-col gap-6">
            {cards.map((card, i) => (
              <article
                key={i}
                className="overflow-hidden rounded-lg border border-border-base bg-surface-raised shadow-sm"
              >
                {card.title && (
                  <h2 className="border-b border-border-subtle px-5 py-3 text-base font-semibold text-ink-strong">
                    {card.title}
                  </h2>
                )}
                <div className="px-5 py-4">
                  {card.kind === 'markdown' ? (
                    <Markdown source={card.body} />
                  ) : (
                    <SqlCode source={card.body} />
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

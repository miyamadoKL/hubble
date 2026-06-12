import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { cn } from '../../utils/cn';

/**
 * A markdown cell body (design.md §6, P4a §2). Renders the markdown preview;
 * clicking it (or pressing the edit button) swaps in a mono textarea. Blur or
 * Ctrl/Cmd+Enter commits and returns to the rendered view.
 *
 * The editor is a separate component mounted only while editing, so its draft
 * state initialises from `source` on mount — no setState-in-effect needed.
 */
export function MarkdownCell({
  source,
  editing,
  onStartEdit,
  onChange,
  onCommit,
}: {
  source: string;
  editing: boolean;
  onStartEdit: () => void;
  onChange: (next: string) => void;
  onCommit: () => void;
}) {
  if (editing) {
    return <MarkdownEditor source={source} onChange={onChange} onCommit={onCommit} />;
  }
  return (
    <button
      type="button"
      onClick={onStartEdit}
      aria-label="Edit markdown"
      className="block w-full cursor-text bg-surface-raised px-5 py-4 text-left"
    >
      {source.trim() ? (
        <Markdown source={source} />
      ) : (
        <span className="text-sm text-ink-subtle italic">Empty markdown cell — click to edit</span>
      )}
    </button>
  );
}

function MarkdownEditor({
  source,
  onChange,
  onCommit,
}: {
  source: string;
  onChange: (next: string) => void;
  onCommit: () => void;
}) {
  const [draft, setDraft] = useState(source);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus + place the caret at the end on mount (external DOM sync, not state).
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  const commit = () => {
    onChange(draft);
    onCommit();
  };

  return (
    <div className="bg-surface-raised px-5 py-4">
      <textarea
        ref={textareaRef}
        value={draft}
        aria-label="Markdown source"
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(source);
            onCommit();
          }
        }}
        rows={3}
        className={cn(
          'w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-ink-base',
          'placeholder:text-ink-subtle focus:outline-none',
        )}
        placeholder="Write markdown… (Ctrl+Enter to render)"
      />
    </div>
  );
}

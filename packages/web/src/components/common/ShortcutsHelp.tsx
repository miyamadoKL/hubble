import { Modal } from './Modal';
import { Kbd } from './Kbd';
import { SHORTCUTS } from '../../hooks/shortcuts';

/**
 * "Keyboard shortcuts" reference modal (design.md §5). Opened from the command
 * palette; lists the canonical shortcut registry so the keys shown here, in the
 * palette, and the runtime dispatcher all come from one source (`SHORTCUTS`).
 */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" className="max-w-md">
      <ul className="divide-y divide-border-subtle">
        {SHORTCUTS.map((s) => (
          <li key={`${s.action}-${s.keys.join('+')}`} className="flex items-center justify-between gap-4 py-2">
            <span className="text-sm text-ink-base">{s.label}</span>
            <Kbd keys={s.keys} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-2xs text-ink-subtle">
        On macOS, ⌘ stands in for Ctrl. Run, format and save also work from inside the editor.
      </p>
    </Modal>
  );
}

import { useState } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';

/**
 * Notebook save dialog (design.md §5 管理: 名前入力モーダル + Save As). Used both
 * for the first save of a draft and for "Save As". The caller supplies the
 * initial name and receives the chosen name on confirm.
 */
export function SaveNotebookModal({
  open,
  initialName,
  title = 'Save notebook',
  confirmLabel = 'Save',
  onClose,
  onConfirm,
}: {
  open: boolean;
  initialName: string;
  title?: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);

  // Reset the field each time the dialog opens by keying on `open` via a render
  // guard: when closed we don't render, so a fresh mount restores the initial.
  if (!open) return null;

  const confirm = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Give the notebook a name to save it to the server."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} disabled={!name.trim()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-2xs font-semibold tracking-wide text-ink-muted uppercase">
          Notebook name
        </span>
        <input
          autoFocus
          value={name}
          aria-label="Notebook name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm();
          }}
          placeholder="Untitled notebook"
          className="w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none"
        />
      </label>
    </Modal>
  );
}

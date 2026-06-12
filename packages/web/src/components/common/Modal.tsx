import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { IconButton } from './IconButton';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Centered modal dialog with scrim. Closes on Escape and backdrop click. */
export function Modal({ open, onClose, title, description, children, footer, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-strong/40 animate-[fadeIn_150ms_ease-out]"
      />
      <div
        className={cn(
          'relative z-10 w-full max-w-lg rounded-lg border border-border-strong bg-surface-overlay shadow-lg',
          'animate-[fadeIn_150ms_ease-out]',
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-strong">{title}</h2>
            {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} tooltip={false} />
        </header>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

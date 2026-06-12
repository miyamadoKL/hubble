import { useEffect } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Toast notifications (design.md §6: success / error 2 variants). A tiny zustand
 * store drives a fixed container; toasts fade/slide in within the motion budget.
 */

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id'>) => string;
  dismiss: (id: string) => void;
}

let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `toast-${++counter}`;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper for demo triggers (e.g. theme switch). */
export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ variant: 'success', title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ variant: 'error', title, description }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ variant: 'info', title, description }),
};

const VARIANT_ICON = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

const accentBar: Record<ToastVariant, string> = {
  success: 'bg-success',
  error: 'bg-error',
  info: 'bg-running',
};

const iconColor: Record<ToastVariant, string> = {
  success: 'text-success',
  error: 'text-error',
  info: 'text-running',
};

const AUTO_DISMISS_MS = 4000;

function ToastRow({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = VARIANT_ICON[item.variant];

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [item.id, dismiss]);

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto relative flex w-80 items-start gap-3 overflow-hidden rounded-md border border-border-strong',
        'bg-surface-overlay py-2.5 pr-2.5 pl-3 shadow-lg',
        'animate-[slideInRight_150ms_ease-out]',
      )}
    >
      <span className={cn('mt-px shrink-0', iconColor[item.variant])}>
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-strong">{item.title}</p>
        {item.description && <p className="mt-0.5 text-xs text-ink-muted">{item.description}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(item.id)}
        className="shrink-0 rounded-sm p-0.5 text-ink-subtle hover:text-ink-strong"
      >
        <X size={14} strokeWidth={2} />
      </button>
      <span className={cn('absolute top-0 left-0 h-full w-0.5', accentBar[item.variant])} />
    </div>
  );
}

/** Fixed toast viewport, mounted once at the app root. */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col gap-2">
      {toasts.map((item) => (
        <div key={item.id} className="relative">
          <ToastRow item={item} />
        </div>
      ))}
    </div>
  );
}

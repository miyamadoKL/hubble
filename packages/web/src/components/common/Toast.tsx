/**
 * Sonnerを使ったトースト通知の命令的APIと表示領域。
 * 成功と情報は4秒後、エラーは手動で閉じるまで表示する。
 */
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Toaster, toast as sonnerToast } from 'sonner';

const AUTO_DISMISS_MS = 4000;
const DISMISS_LABEL = 'Dismiss notification';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastMessageProps {
  variant: ToastVariant;
  title: string;
  description?: string;
}

function ToastMessage({ variant, title, description }: ToastMessageProps) {
  const isError = variant === 'error';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      className="min-w-0 flex-1"
    >
      <p className="text-sm font-medium text-ink-strong">{title}</p>
      {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
    </div>
  );
}

const toastOptions = (duration: number) => ({ duration });

/** 既存の通知呼び出しをSonnerへ委譲する公開API。 */
export const toast = {
  success: (title: string, description?: string) =>
    sonnerToast.success(
      <ToastMessage variant="success" title={title} description={description} />,
      toastOptions(AUTO_DISMISS_MS),
    ),
  error: (title: string, description?: string) =>
    sonnerToast.error(
      <ToastMessage variant="error" title={title} description={description} />,
      toastOptions(Infinity),
    ),
  info: (title: string, description?: string) =>
    sonnerToast.info(
      <ToastMessage variant="info" title={title} description={description} />,
      toastOptions(AUTO_DISMISS_MS),
    ),
  /** 通知を任意のタイミングで閉じるための公開API。 */
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};

const icons = {
  success: <CheckCircle2 className="text-success" size={16} strokeWidth={1.75} />,
  error: <AlertTriangle className="text-error" size={16} strokeWidth={1.75} />,
  info: <Info className="text-running" size={16} strokeWidth={1.75} />,
};

const classNames = {
  toast:
    'pointer-events-auto relative flex w-80 items-start gap-3 overflow-hidden rounded-md border border-border-strong bg-surface-overlay py-2.5 pr-3 pl-3 shadow-lg',
  content: 'min-w-0 flex-1',
  icon: 'mt-px shrink-0',
  closeButton: 'order-last ml-auto shrink-0 rounded-sm p-0.5 text-ink-subtle hover:text-ink-strong',
  success: 'border-l-2 border-l-success',
  error: 'border-l-2 border-l-error',
  info: 'border-l-2 border-l-running',
};

/**
 * アプリのルートに一度だけマウントされる、トーストの表示領域。
 * 外側のlive region wrapperはModalの背景inert処理から除外する契約を保つ。
 */
export function ToastViewport() {
  return (
    <div data-modal-live-region="">
      <Toaster
        position="bottom-right"
        offset={16}
        gap={8}
        style={{ zIndex: 100 }}
        closeButton
        toastOptions={{
          unstyled: true,
          closeButtonAriaLabel: DISMISS_LABEL,
          classNames,
        }}
        icons={icons}
      />
    </div>
  );
}

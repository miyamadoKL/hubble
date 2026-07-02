/**
 * トースト通知（画面右下に一時的に表示される通知）を管理し、描画するモジュール。
 * zustand の小さなストアで通知一覧の状態を保持し、`toast.success()` などの
 * 命令的APIから通知を積み、`ToastViewport` がそれらを固定表示する。
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Toast notifications (design.md §6: success / error 2 variants). A tiny zustand
 * store drives a fixed container; toasts fade/slide in within the motion budget.
 *
 * トースト通知の実装。success / error / info の3種類のバリアントを持ち、
 * 小さな zustand ストアが固定位置のコンテナを駆動する。各トーストは
 * モーションバジェット内でフェード/スライドインする。
 */

/** トーストの種類（見た目、アイコン、色を決定する）。 */
export type ToastVariant = 'success' | 'error' | 'info';

/**
 * 1件のトースト通知を表すデータ。
 */
export interface ToastItem {
  /** トーストを一意に識別するID（自動採番）。 */
  id: string;
  /** トーストの種類。 */
  variant: ToastVariant;
  /** トーストのタイトル文言。 */
  title: string;
  /** タイトルの下に表示する補足説明（任意）。 */
  description?: string;
}

/**
 * zustand ストアが保持する状態と操作。
 */
interface ToastState {
  /** 現在表示中のトースト一覧。 */
  toasts: ToastItem[];
  /** 新しいトーストを追加し、採番された id を返す。 */
  push: (toast: Omit<ToastItem, 'id'>) => string;
  /** 指定した id のトーストを一覧から取り除く。 */
  dismiss: (id: string) => void;
}

// トーストID採番用のカウンター（モジュールスコープで単純にインクリメントする）
let counter = 0;

// トースト一覧を保持する zustand ストア本体
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    // カウンターをインクリメントして一意なIDを生成し、既存の一覧に追加する
    const id = `toast-${++counter}`;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    return id;
  },
  // id が一致するトーストだけを除外した新しい配列で置き換える
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper for demo triggers (e.g. theme switch). */
/**
 * どこからでも呼び出せる命令的なトースト表示ヘルパー。
 * （テーマ切り替えなどのデモトリガーから使うことを想定）
 * variant ごとに `useToastStore` の `push` を呼び出すだけの薄いラッパー。
 */
export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ variant: 'success', title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ variant: 'error', title, description }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ variant: 'info', title, description }),
};

// バリアントごとに表示するアイコンコンポーネント
const VARIANT_ICON = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

// バリアントごとの左端アクセントバーの色クラス
const accentBar: Record<ToastVariant, string> = {
  success: 'bg-success',
  error: 'bg-error',
  info: 'bg-running',
};

// バリアントごとのアイコン色クラス
const iconColor: Record<ToastVariant, string> = {
  success: 'text-success',
  error: 'text-error',
  info: 'text-running',
};

// トーストが自動的に消えるまでの待機時間（ミリ秒）
const AUTO_DISMISS_MS = 4000;

/**
 * トースト1件分の行を描画する内部コンポーネント。
 * 表示後 `AUTO_DISMISS_MS` 経過すると自動的に閉じるタイマーを持つ。
 */
function ToastRow({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = VARIANT_ICON[item.variant];

  // マウント時に自動消去用のタイマーをセットし、アンマウント時（または item 変化時）にクリアする
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
      {/* バリアントに応じたアイコン（成功/エラー/情報）を表示 */}
      <span className={cn('mt-px shrink-0', iconColor[item.variant])}>
        <Icon size={16} strokeWidth={1.75} />
      </span>
      {/* タイトルと、あれば補足説明を表示 */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-strong">{item.title}</p>
        {item.description && <p className="mt-0.5 text-xs text-ink-muted">{item.description}</p>}
      </div>
      {/* 手動で閉じるための×ボタン */}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(item.id)}
        className="shrink-0 rounded-sm p-0.5 text-ink-subtle hover:text-ink-strong"
      >
        <X size={14} strokeWidth={2} />
      </button>
      {/* バリアントを示す左端の縦アクセントバー */}
      <span className={cn('absolute top-0 left-0 h-full w-0.5', accentBar[item.variant])} />
    </div>
  );
}

/** Fixed toast viewport, mounted once at the app root. */
/**
 * アプリのルートに一度だけマウントされる、トーストの固定表示領域。
 * ストア内の toasts 一覧を購読し、画面右下に縦に積んで表示する。
 */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col gap-2">
      {/* 現在表示中のトーストを1件ずつ ToastRow として描画する */}
      {toasts.map((item) => (
        <div key={item.id} className="relative">
          <ToastRow item={item} />
        </div>
      ))}
    </div>
  );
}

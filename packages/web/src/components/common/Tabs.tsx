/**
 * 水平タブを描画する汎用コンポーネントを提供するモジュール。
 * 見た目のバリエーションとして、下線でアクティブタブを示す
 * "underline" と、コンパクトなピル型の "segmented" の2種類を持つ。
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * 1つのタブ項目を表す型。
 */
export interface TabItem<T extends string> {
  /** タブを一意に識別するID（value と比較される）。 */
  id: T;
  /** タブに表示するラベル文字列。 */
  label: string;
  /** タブの先頭に表示するアイコン（任意）。 */
  icon?: LucideIcon;
  /** ラベルの後ろに表示するバッジ要素（任意）。 */
  badge?: ReactNode;
  /** タブを無効化するかどうか。 */
  disabled?: boolean;
}

/**
 * Tabs コンポーネントの props。
 */
interface TabsProps<T extends string> {
  /** 表示するタブ項目の配列。 */
  items: TabItem<T>[];
  /** 現在アクティブなタブの id。 */
  value: T;
  /** タブが選択されたときに呼び出されるコールバック。 */
  onChange: (id: T) => void;
  /** 追加で付与する className。 */
  className?: string;
  /** 'underline' for result-pane style, 'segmented' for compact pill style. */
  /** 見た目のバリエーション。'underline' は結果ペイン風、'segmented' はコンパクトなピル型。 */
  variant?: 'underline' | 'segmented';
}

/**
 * Horizontal tabs. The underline variant renders the signature active-tab
 * underline ("記憶に残るディテール"): a 2px accent bar that sits on
 * the container's hairline.
 *
 * 水平タブコンポーネント。variant に応じて "underline"（アクティブなタブの
 * 下に2pxのアクセントバーを表示する、デザインの特徴的なディテール）と
 * "segmented"（枠で囲まれたコンパクトなピル型）のいずれかを描画する。
 *
 * @param items - 表示するタブ項目の一覧。
 * @param value - 現在アクティブなタブの id。
 * @param onChange - タブ選択時に呼ばれるコールバック。
 * @param className - 追加のクラス名。
 * @param variant - タブの見た目バリエーション（デフォルトは 'underline'）。
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  variant = 'underline',
}: TabsProps<T>) {
  // segmented バリアント: 枠付きコンテナ内にピル型のボタンを並べるコンパクトな見た目
  if (variant === 'segmented') {
    return (
      <div
        role="tablist"
        className={cn(
          'inline-flex items-center gap-0.5 rounded-md border border-border-base bg-surface-inset p-0.5',
          className,
        )}
      >
        {/* items 配列を1つずつボタンとして描画し、value と一致する id をアクティブ表示する */}
        {items.map((item) => {
          const active = item.id === value;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors duration-100',
                'disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? 'bg-surface-raised text-ink-strong shadow-sm'
                  : 'text-ink-muted hover:text-ink-strong',
              )}
            >
              {/* アイコン、ラベル、バッジをこの順に表示（アイコンとバッジは任意） */}
              {Icon && <Icon size={13} strokeWidth={1.75} />}
              {item.label}
              {item.badge}
            </button>
          );
        })}
      </div>
    );
  }

  // underline バリアント（デフォルト）: コンテナ下部の罫線上にアクティブタブの下線を重ねて表示する
  return (
    <div
      role="tablist"
      className={cn('flex items-stretch gap-0.5 border-b border-border-base', className)}
    >
      {/* items 配列を1つずつボタンとして描画し、アクティブなタブにはアクセントカラーの下線を付与する */}
      {items.map((item) => {
        const active = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            className={cn(
              'relative inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors duration-100',
              '-mb-px border-b-2 disabled:cursor-not-allowed disabled:opacity-40',
              active
                ? 'border-accent text-ink-strong'
                : 'border-transparent text-ink-muted hover:text-ink-strong',
            )}
          >
            {/* アイコン、ラベル、バッジをこの順に表示（アイコンとバッジは任意） */}
            {Icon && <Icon size={14} strokeWidth={1.75} />}
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

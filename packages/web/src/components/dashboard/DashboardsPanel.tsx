/**
 * ダッシュボード一覧パネル (サイドバー内)。
 *
 * 登録済みダッシュボードを一覧表示し、行クリックでメインエリアの
 * ダッシュボードビュー (DashboardView) を開く。新規作成ボタンは
 * 新規作成ビューを開くだけで、編集はメインエリア側が持つ
 * (WorkflowsPanel と同じ構成)。
 */
import { useMemo } from 'react';
import type { DashboardListItem } from '@hubble/contracts';
import { LayoutDashboard, Plus } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Button } from '../common/Button';
import { DocumentShareBadge } from '../common/DocumentShareBadge';
import { useDashboards } from '../../hooks/useDashboards';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../utils/cn';
import { useT, type TFn } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { dashboardMessages } from '../../i18n/messages/dashboard';

/** DashboardsPanel 内で使う辞書の合成。共通文言 + Dashboard 固有文言。 */
const dashboardsPanelDict = { ...commonMessages, ...dashboardMessages } as const;

/**
 * ダッシュボード一覧の 1 行分。名前、widget 数、共有バッジを表示する。
 * @param item 表示対象の一覧アイテム。
 * @param active 現在メインエリアで開かれているかどうか。
 * @param onOpen 行クリック時のコールバック。
 */
function DashboardRow({
  item,
  active,
  onOpen,
  t,
}: {
  item: DashboardListItem;
  active: boolean;
  onOpen: () => void;
  t: TFn<typeof dashboardsPanelDict>;
}) {
  return (
    <li className="border-b border-border-subtle">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active || undefined}
        className={cn(
          'flex w-full flex-col gap-1.5 px-3 py-2.5 text-left transition-colors',
          active ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
        )}
      >
        <span className="flex items-center gap-2">
          <LayoutDashboard
            size={15}
            strokeWidth={1.75}
            className={cn('shrink-0', active ? 'text-accent' : 'text-ink-muted')}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-medium',
              active ? 'text-accent' : 'text-ink-strong',
            )}
          >
            {item.name}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 pl-6">
          <span className="font-mono text-2xs text-ink-subtle">
            {item.widgetCount === 1
              ? t('widgetCountOne', { n: item.widgetCount })
              : t('widgetCountOther', { n: item.widgetCount })}
          </span>
          <DocumentShareBadge owner={item.owner} myPermission={item.myPermission} />
        </span>
      </button>
    </li>
  );
}

/**
 * ダッシュボードパネル本体。
 * @param search 検索語 (親の検索ボックスから渡される)。名前または説明への
 *   部分一致 (大文字小文字無視) でクライアント側絞り込みを行う。
 */
export function DashboardsPanel({ search }: { search: string }) {
  const t = useT(dashboardsPanelDict);
  const list = useDashboards();
  const dashboardView = useUiStore((s) => s.dashboardView);
  const openDashboard = useUiStore((s) => s.openDashboard);
  const openNewDashboard = useUiStore((s) => s.openNewDashboard);

  // 検索語で絞り込み、名前順に並べ替える。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = list.data ?? [];
    const matched = q
      ? items.filter(
          (d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
        )
      : items;
    return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  }, [list.data, search]);

  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> {t('loading')}
      </div>
    );
  }

  if (list.isError) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        title={t('couldntLoadDashboardsTitle')}
        description={t('serverDidntRespond')}
        compact
      />
    );
  }

  return (
    <div className="flex flex-col">
      {/* 新規作成ボタン。メインエリアの新規作成ビューを開く。 */}
      <div className="px-3 pb-2">
        <Button
          variant="default"
          size="sm"
          icon={Plus}
          onClick={openNewDashboard}
          className="w-full justify-center"
        >
          {t('newDashboardButton')}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title={search.trim() ? t('noMatches') : t('noDashboardsTitle')}
          description={search.trim() ? t('tryDifferentSearchTerm') : t('noDashboardsDescription')}
          compact
        />
      ) : (
        <ul className="flex flex-col">
          {filtered.map((item) => (
            <DashboardRow
              key={item.id}
              item={item}
              active={dashboardView?.kind === 'dashboard' && dashboardView.id === item.id}
              onOpen={() => openDashboard(item.id)}
              t={t}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

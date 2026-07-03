/**
 * アプリ左側のサイドバー本体。
 * アイコンレール（Data / Notebooks / Saved / History / Schedules の切り替え）と、
 * 選択中タブに応じたパネル（検索欄 + 一覧）、幅のドラッグリサイズ、折りたたみを担当する。
 * design.md §6 で定義されたシェルの一部で、幅、選択タブ、折りたたみ状態は uiStore に永続化される。
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  Activity,
  BookMarked,
  CalendarClock,
  Database,
  History,
  NotebookText,
  PanelLeftClose,
  type LucideIcon,
} from 'lucide-react';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useUiStore,
  type SidebarTab,
} from '../../stores/uiStore';
import { SearchInput } from '../common/SearchInput';
import { Tooltip } from '../common/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { SchemaTree } from '../data/SchemaTree';
import { NotebookListPanel } from '../panels/NotebookListPanel';
import { SavedQueriesPanel } from '../panels/SavedQueriesPanel';
import { HistoryPanel } from '../panels/HistoryPanel';
import { SchedulesPanel } from '../panels/SchedulesPanel';
import { OperationsPanel } from '../panels/OperationsPanel';
import { useMe } from '../../hooks/useMe';
import { hasPermission } from '../../permissions';
import { listNotebooks } from '../../api/notebooks';
import { getNotebook } from '../../api/notebooks';
import { useNotebookStore } from '../../notebook';
import { cn } from '../../utils/cn';

/**
 * Sidebar (design.md §6): icon section rail (Data / Notebooks / Saved /
 * History), a per-panel search field, a drag handle to resize, and a collapse
 * control. Width and active tab persist via the UI store.
 */

/** アイコンレールに並べる1項目の定義（タブID、アイコン、アクセシビリティラベル）。 */
interface RailItem {
  id: SidebarTab;
  icon: LucideIcon;
  label: string;
}

// レールに表示するタブの並び。表示順もここで決まる。
const RAIL: RailItem[] = [
  { id: 'data', icon: Database, label: 'Data' },
  { id: 'notebooks', icon: NotebookText, label: 'Notebooks' },
  { id: 'saved', icon: BookMarked, label: 'Saved' },
  { id: 'history', icon: History, label: 'History' },
  { id: 'schedules', icon: CalendarClock, label: 'Schedules' },
  { id: 'operations', icon: Activity, label: 'Operations' },
];

// 各タブのパネル見出しに表示する文言。
const PANEL_TITLE: Record<SidebarTab, string> = {
  data: 'Data browser',
  notebooks: 'Notebooks',
  saved: 'Saved queries',
  history: 'History',
  schedules: 'Schedules',
  operations: 'Operations',
};

// 各タブの検索欄に表示するプレースホルダー文言。
const PANEL_PLACEHOLDER: Record<SidebarTab, string> = {
  data: 'Filter tables…',
  notebooks: 'Search notebooks…',
  saved: 'Search saved queries…',
  history: 'Search history…',
  schedules: 'Search schedules…',
  operations: 'Filter queries…',
};

/**
 * サイドバー本体コンポーネント。
 *
 * @param search - 現在アクティブなパネルの検索文字列（コントロールドコンポーネント）。
 * @param onSearchChange - 検索文字列が変更されたときに呼ばれるコールバック。
 * @param activeNotebookId - 現在アクティブなノートブックのID。Notebooks パネルの選択状態表示に使う。
 * @param context - 現在の catalog / schema コンテキスト。Data パネル（SchemaTree）へ渡す。
 */
export function Sidebar({
  search,
  onSearchChange,
  activeNotebookId,
  context,
  datasourceId,
  flattenCatalog,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  activeNotebookId: string;
  context: { catalog?: string; schema?: string };
  datasourceId?: string;
  flattenCatalog?: boolean;
}) {
  const { data: me } = useMe();
  const canViewOperations = hasPermission(me, 'queries.viewAll');
  const tab = useUiStore((s) => s.sidebarTab);
  const setTab = useUiStore((s) => s.setSidebarTab);
  const effectiveTab = tab === 'operations' && !canViewOperations ? 'data' : tab;
  const visibleRail = RAIL.filter((item) => item.id !== 'operations' || canViewOperations);
  const width = useUiStore((s) => s.sidebarWidth);
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const focusNonce = useUiStore((s) => s.sidebarFocusNonce);

  const searchRef = useRef<HTMLInputElement>(null);
  // リサイズハンドルのドラッグ中かどうか。再レンダーを起こしたくないので ref で保持する。
  const draggingRef = useRef(false);

  // Focus the panel search when a "Go to …" command requests it (command palette).
  useEffect(() => {
    if (focusNonce === 0) return;
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [focusNonce]);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      // Rail is 44px wide; panel starts after it.
      setWidth(e.clientX - 44);
    },
    [setWidth],
  );

  // ドラッグ終了時に ref をリセットし、ドラッグ中に付けたカーソル/選択禁止のスタイルを戻す。
  const stopDrag = useCallback(() => {
    draggingRef.current = false;
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }, []);

  // ポインタ移動/離脱は resize handle 以外の場所でも発生しうるため、window に直接登録する。
  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
    };
  }, [onPointerMove, stopDrag]);

  // リサイズハンドルの pointerdown で呼ばれ、ドラッグ中の見た目（col-resize カーソル、
  // テキスト選択の禁止）を適用する。
  const startDrag = () => {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside className="flex h-full shrink-0">
      {/* Icon rail */}
      {/* 左端のアイコンレール。タブ切り替えと、同じタブを再クリックしたときの折りたたみを兼ねる。 */}
      <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border-base bg-surface-base py-2">
        {/* RAIL に定義された各タブをアイコンボタンとして描画する。 */}
        {visibleRail.map((item) => {
          const active = effectiveTab === item.id && !collapsed;
          const Icon = item.icon;
          return (
            <Tooltip key={item.id} label={item.label} side="right">
              <button
                type="button"
                aria-label={item.label}
                aria-current={active || undefined}
                onClick={() => {
                  if (effectiveTab === item.id && !collapsed) toggleSidebar();
                  else setTab(item.id);
                }}
                className={cn(
                  'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                  active
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
                )}
              >
                {active && (
                  <span className="absolute top-1.5 -left-2 h-6 w-0.5 rounded-full bg-accent" />
                )}
                <Icon size={18} strokeWidth={1.75} />
              </button>
            </Tooltip>
          );
        })}
      </nav>

      {/* Panel */}
      {/* 右側のパネル本体。折りたたまれている（collapsed）間はマウントしない。 */}
      {!collapsed && (
        <div
          className="relative flex h-full flex-col border-r border-border-base bg-surface-base"
          style={{ width: `${width}px` }}
        >
          {/* パネル見出しと折りたたみボタン。 */}
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <h2 className="text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
              {PANEL_TITLE[effectiveTab]}
            </h2>
            <Tooltip label="Collapse sidebar" side="bottom">
              <button
                type="button"
                aria-label="Collapse sidebar"
                onClick={toggleSidebar}
                className="rounded-sm p-1 text-ink-subtle hover:text-ink-strong"
              >
                <PanelLeftClose size={15} strokeWidth={1.75} />
              </button>
            </Tooltip>
          </div>

          {/* History filters by state chips, not text — hide the search field. */}
          {/* History タブだけは文字列検索ではなく状態チップで絞り込むため、検索欄自体を出さない。 */}
          {effectiveTab !== 'history' && effectiveTab !== 'operations' && (
            <div className="px-3 pb-2">
              <SearchInput
                inputRef={searchRef}
                value={search}
                onChange={onSearchChange}
                placeholder={PANEL_PLACEHOLDER[effectiveTab]}
              />
            </div>
          )}

          {/* 選択中タブに応じてパネル本体を出し分ける（同時に描画されるのは1つだけ）。 */}
          <div className="min-h-0 flex-1 overflow-auto">
            {effectiveTab === 'data' && datasourceId && (
              <SchemaTree
                filter={search}
                context={context}
                datasourceId={datasourceId}
                flattenCatalog={flattenCatalog}
              />
            )}
            {effectiveTab === 'notebooks' && (
              <NotebooksSidebarPanel search={search} activeNotebookId={activeNotebookId} />
            )}
            {effectiveTab === 'saved' && <SavedQueriesPanel search={search} />}
            {effectiveTab === 'history' && <HistoryPanel />}
            {effectiveTab === 'schedules' && <SchedulesPanel search={search} />}
            {effectiveTab === 'operations' && <OperationsPanel />}
          </div>

          {/* Resize handle */}
          {/* パネル右端のリサイズハンドル。ドラッグ（pointerdown 起点）と矢印キーの両方で幅を変更できる。 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={width}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            tabIndex={0}
            onPointerDown={startDrag}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setWidth(width - 16);
              else if (e.key === 'ArrowRight') setWidth(width + 16);
            }}
            className="group absolute top-0 -right-1 h-full w-2 cursor-col-resize"
          >
            <span className="absolute top-0 left-1 h-full w-px bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * The Notebooks sidebar panel: the saved notebooks from the server (design.md §5
 * Notebook 一覧 / 検索 / 再オープン). Clicking a row fetches the full notebook and
 * opens it in a tab (the store dedupes if it's already open).
 *
 * @param search - Notebooks パネルの検索文字列。サーバー側の一覧取得に渡す。
 * @param activeNotebookId - 現在アクティブなノートブックID。行のハイライトに使う。
 */
function NotebooksSidebarPanel({
  search,
  activeNotebookId,
}: {
  search: string;
  activeNotebookId: string;
}) {
  // 検索文字列が変わるたびにサーバーへ再問い合わせする（クライアント側でのフィルタはしない）。
  const { data } = useQuery({
    queryKey: ['notebooks', 'list', search],
    queryFn: () => listNotebooks(search.trim() || undefined),
  });

  // ノートブック行クリック時の処理。既に開いていればタブを切り替えるだけ、未オープンなら
  // サーバーから全文を取得してタブとして開く。取得に失敗した場合（削除済み等）は無視する。
  const open = async (id: string) => {
    const store = useNotebookStore.getState();
    if (store.open[id]) {
      store.setActive(id);
      return;
    }
    try {
      const nb = await getNotebook(id);
      store.openNotebook(nb, { draft: false, activate: true });
    } catch {
      /* gone — ignore */
    }
  };

  return (
    <NotebookListPanel
      notebooks={data ?? []}
      activeId={activeNotebookId}
      onOpen={(id) => void open(id)}
    />
  );
}

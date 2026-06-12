import { useCallback, useEffect, useRef } from 'react';
import {
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
import { listNotebooks } from '../../api/notebooks';
import { getNotebook } from '../../api/notebooks';
import { useNotebookStore } from '../../notebook';
import { cn } from '../../utils/cn';

/**
 * Sidebar (design.md §6): icon section rail (Data / Notebooks / Saved /
 * History), a per-panel search field, a drag handle to resize, and a collapse
 * control. Width and active tab persist via the UI store.
 */

interface RailItem {
  id: SidebarTab;
  icon: LucideIcon;
  label: string;
}

const RAIL: RailItem[] = [
  { id: 'data', icon: Database, label: 'Data' },
  { id: 'notebooks', icon: NotebookText, label: 'Notebooks' },
  { id: 'saved', icon: BookMarked, label: 'Saved' },
  { id: 'history', icon: History, label: 'History' },
  { id: 'schedules', icon: CalendarClock, label: 'Schedules' },
];

const PANEL_TITLE: Record<SidebarTab, string> = {
  data: 'Data browser',
  notebooks: 'Notebooks',
  saved: 'Saved queries',
  history: 'History',
  schedules: 'Schedules',
};

const PANEL_PLACEHOLDER: Record<SidebarTab, string> = {
  data: 'Filter tables…',
  notebooks: 'Search notebooks…',
  saved: 'Search saved queries…',
  history: 'Search history…',
  schedules: 'Search schedules…',
};

export function Sidebar({
  search,
  onSearchChange,
  activeNotebookId,
  context,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  activeNotebookId: string;
  context: { catalog?: string; schema?: string };
}) {
  const tab = useUiStore((s) => s.sidebarTab);
  const setTab = useUiStore((s) => s.setSidebarTab);
  const width = useUiStore((s) => s.sidebarWidth);
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const focusNonce = useUiStore((s) => s.sidebarFocusNonce);

  const searchRef = useRef<HTMLInputElement>(null);
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

  const stopDrag = useCallback(() => {
    draggingRef.current = false;
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
    };
  }, [onPointerMove, stopDrag]);

  const startDrag = () => {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside className="flex h-full shrink-0">
      {/* Icon rail */}
      <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border-base bg-surface-base py-2">
        {RAIL.map((item) => {
          const active = tab === item.id && !collapsed;
          const Icon = item.icon;
          return (
            <Tooltip key={item.id} label={item.label} side="right">
              <button
                type="button"
                aria-label={item.label}
                aria-current={active || undefined}
                onClick={() => {
                  if (tab === item.id && !collapsed) toggleSidebar();
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
      {!collapsed && (
        <div
          className="relative flex h-full flex-col border-r border-border-base bg-surface-base"
          style={{ width: `${width}px` }}
        >
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <h2 className="text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
              {PANEL_TITLE[tab]}
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
          {tab !== 'history' && (
            <div className="px-3 pb-2">
              <SearchInput
                inputRef={searchRef}
                value={search}
                onChange={onSearchChange}
                placeholder={PANEL_PLACEHOLDER[tab]}
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'data' && <SchemaTree filter={search} context={context} />}
            {tab === 'notebooks' && (
              <NotebooksSidebarPanel search={search} activeNotebookId={activeNotebookId} />
            )}
            {tab === 'saved' && <SavedQueriesPanel search={search} />}
            {tab === 'history' && <HistoryPanel />}
            {tab === 'schedules' && <SchedulesPanel search={search} />}
          </div>

          {/* Resize handle */}
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
 */
function NotebooksSidebarPanel({
  search,
  activeNotebookId,
}: {
  search: string;
  activeNotebookId: string;
}) {
  const { data } = useQuery({
    queryKey: ['notebooks', 'list', search],
    queryFn: () => listNotebooks(search.trim() || undefined),
  });

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

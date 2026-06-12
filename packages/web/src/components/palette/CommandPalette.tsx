import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookMarked,
  Code2,
  Database,
  FileCode2,
  FilePlus2,
  FileText,
  History,
  Keyboard,
  Moon,
  NotebookText,
  Play,
  Presentation,
  Save,
  Search,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useUiStore } from '../../stores/uiStore';
import { Kbd } from '../common/Kbd';
import { Spinner } from '../common/Spinner';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';
import { useNotebookStore, runAllCells, saveActiveNotebook } from '../../notebook';
import { listNotebooks, getNotebook } from '../../api/notebooks';
import { formatRelativeTime } from '../../utils/format';

/**
 * Command palette (design.md §6: Ctrl+K). P4b completes it: navigation entries
 * use `gotoSidebar` (switch tab + expand + focus its search), a "Open notebook…"
 * entry drops into a searchable notebook list, and the action set is organised as
 * a registry built from injected handlers so new actions are easy to add.
 *
 * The content is split into a freshly-mounted inner component so each open starts
 * with clean query/selection state (no reset-in-effect).
 */

interface Command {
  id: string;
  label: string;
  icon: LucideIcon;
  group: string;
  shortcut?: string[];
  run: () => void;
}

type PaletteMode = 'commands' | 'open-notebook';

/** Build the command registry from injected handlers (design.md §6 registry). */
function buildCommands(deps: {
  context: { catalog: string; schema: string };
  defaultLimit: number;
  theme: 'light' | 'dark';
  presentationMode: boolean;
  gotoSidebar: (tab: 'data' | 'notebooks' | 'saved' | 'history') => void;
  toggleTheme: () => void;
  togglePresentation: () => void;
  openShortcutsHelp: () => void;
  requestSave: (mode: 'save' | 'saveAs') => void;
  enterOpenNotebook: () => void;
}): Command[] {
  const {
    context,
    defaultLimit,
    theme,
    presentationMode,
    gotoSidebar,
    toggleTheme,
    togglePresentation,
    openShortcutsHelp,
    requestSave,
    enterOpenNotebook,
  } = deps;

  const addCellToActive = (kind: 'sql' | 'markdown') => {
    const store = useNotebookStore.getState();
    const id = store.activeId;
    if (!id) {
      toast.info('No notebook open', 'Create a notebook first.');
      return;
    }
    store.addCell(id, kind, 'end');
    toast.info(kind === 'sql' ? 'New SQL cell' : 'New Markdown cell');
  };

  return [
    {
      id: 'run-all',
      label: 'Run all cells',
      icon: Play,
      group: 'Query',
      run: () => void runAllCells(context, defaultLimit),
    },
    {
      id: 'save',
      label: 'Save notebook',
      icon: Save,
      group: 'Notebook',
      shortcut: ['Ctrl', 'S'],
      run: () =>
        void saveActiveNotebook().then((r) => {
          if ('needsName' in r) requestSave('save');
        }),
    },
    {
      id: 'save-as',
      label: 'Save notebook as…',
      icon: Save,
      group: 'Notebook',
      run: () => requestSave('saveAs'),
    },
    {
      id: 'new-notebook',
      label: 'New notebook',
      icon: FilePlus2,
      group: 'Notebook',
      run: () => useNotebookStore.getState().createBlankNotebook(),
    },
    {
      id: 'open-notebook',
      label: 'Open notebook…',
      icon: NotebookText,
      group: 'Notebook',
      run: enterOpenNotebook,
    },
    {
      id: 'new-sql',
      label: 'New SQL cell',
      icon: Code2,
      group: 'Notebook',
      run: () => addCellToActive('sql'),
    },
    {
      id: 'new-md',
      label: 'New Markdown cell',
      icon: FileText,
      group: 'Notebook',
      run: () => addCellToActive('markdown'),
    },
    {
      id: 'goto-data',
      label: 'Go to Data browser',
      icon: Database,
      group: 'Navigate',
      run: () => gotoSidebar('data'),
    },
    {
      id: 'goto-saved',
      label: 'Go to Saved queries',
      icon: BookMarked,
      group: 'Navigate',
      run: () => gotoSidebar('saved'),
    },
    {
      id: 'goto-history',
      label: 'Go to History',
      icon: History,
      group: 'Navigate',
      run: () => gotoSidebar('history'),
    },
    {
      id: 'goto-notebooks',
      label: 'Go to Notebooks',
      icon: NotebookText,
      group: 'Navigate',
      run: () => gotoSidebar('notebooks'),
    },
    {
      id: 'theme',
      label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      group: 'Appearance',
      shortcut: ['Ctrl', 'Alt', 'T'],
      run: () => toggleTheme(),
    },
    {
      id: 'presentation',
      label: presentationMode ? 'Exit presentation mode' : 'Enter presentation mode',
      icon: Presentation,
      group: 'Appearance',
      shortcut: ['Ctrl', 'Shift', 'P'],
      run: () => togglePresentation(),
    },
    {
      id: 'shortcuts-help',
      label: 'Keyboard shortcuts',
      icon: Keyboard,
      group: 'Help',
      run: () => openShortcutsHelp(),
    },
  ];
}

function PaletteContent({
  onClose,
  context,
  defaultLimit,
}: {
  onClose: () => void;
  context: { catalog: string; schema: string };
  defaultLimit: number;
}) {
  const gotoSidebar = useUiStore((s) => s.gotoSidebar);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const togglePresentation = useUiStore((s) => s.togglePresentation);
  const setShortcutsHelpOpen = useUiStore((s) => s.setShortcutsHelpOpen);
  const requestSave = useUiStore((s) => s.requestSave);
  const theme = useUiStore((s) => s.theme);
  const presentationMode = useUiStore((s) => s.presentationMode);

  const [mode, setMode] = useState<PaletteMode>('commands');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands = useMemo(
    () =>
      buildCommands({
        context,
        defaultLimit,
        theme,
        presentationMode,
        gotoSidebar,
        toggleTheme,
        togglePresentation,
        openShortcutsHelp: () => setShortcutsHelpOpen(true),
        requestSave,
        enterOpenNotebook: () => {
          setMode('open-notebook');
          setQuery('');
          setActiveIndex(0);
        },
      }),
    [
      context,
      defaultLimit,
      theme,
      presentationMode,
      gotoSidebar,
      toggleTheme,
      togglePresentation,
      setShortcutsHelpOpen,
      requestSave,
    ],
  );

  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(needle));
  }, [commands, query]);

  // Notebook list for "Open notebook…" mode (server search, only while active).
  const notebooks = useQuery({
    queryKey: ['notebooks', 'list', query.trim()],
    queryFn: () => listNotebooks(query.trim() || undefined),
    enabled: mode === 'open-notebook',
  });

  const openNotebook = async (id: string) => {
    const store = useNotebookStore.getState();
    if (store.open[id]) {
      store.setActive(id);
    } else {
      try {
        const nb = await getNotebook(id);
        store.openNotebook(nb, { draft: false, activate: true });
      } catch {
        toast.error('Open failed', 'That notebook could not be loaded.');
      }
    }
    onClose();
  };

  const notebookItems = notebooks.data ?? [];
  const itemCount = mode === 'commands' ? filteredCommands.length : notebookItems.length;
  const safeIndex = Math.min(activeIndex, Math.max(0, itemCount - 1));

  function onQueryChange(value: string) {
    setQuery(value);
    setActiveIndex(0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      if (mode === 'open-notebook') {
        setMode('commands');
        setQuery('');
        setActiveIndex(0);
      } else {
        onClose();
      }
    } else if (e.key === 'Backspace' && mode === 'open-notebook' && query === '') {
      setMode('commands');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(Math.min(itemCount - 1, safeIndex + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(Math.max(0, safeIndex - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'commands') {
        const cmd = filteredCommands[safeIndex];
        if (cmd) {
          cmd.run();
          // Commands that switch to a sub-mode shouldn't close the palette.
          if (cmd.id !== 'open-notebook') onClose();
        }
      } else {
        const nb = notebookItems[safeIndex];
        if (nb) void openNotebook(nb.id);
      }
    }
  }

  const placeholder =
    mode === 'open-notebook' ? 'Search notebooks…' : 'Type a command…';

  return (
    <div className="fixed inset-0 z-[95] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-strong/40 animate-[fadeIn_150ms_ease-out]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-lg border border-border-strong bg-surface-overlay shadow-lg animate-[slideUp_150ms_ease-out]"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-3.5 py-3">
          {mode === 'open-notebook' ? (
            <NotebookText size={16} strokeWidth={1.75} className="shrink-0 text-accent" />
          ) : (
            <Search size={16} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
          )}
          {mode === 'open-notebook' && (
            <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">
              Open
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-base text-ink-strong placeholder:text-ink-subtle focus:outline-none"
          />
          <Kbd keys={['Esc']} />
        </div>

        {mode === 'commands' ? (
          <ul className="max-h-80 overflow-auto py-1.5">
            {filteredCommands.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">No matching commands</li>
            )}
            {filteredCommands.map((cmd, i) => {
              const Icon = cmd.icon;
              const isActive = i === safeIndex;
              return (
                <li key={cmd.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => {
                      cmd.run();
                      if (cmd.id !== 'open-notebook') onClose();
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-accent-soft text-accent' : 'text-ink-base',
                    )}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.75}
                      className={cn('shrink-0', isActive ? 'text-accent' : 'text-ink-muted')}
                    />
                    <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                    <span className="shrink-0 text-2xs tracking-wide text-ink-subtle uppercase">
                      {cmd.group}
                    </span>
                    {cmd.shortcut && <Kbd keys={cmd.shortcut} />}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="max-h-80 overflow-auto py-1.5">
            {notebooks.isPending && (
              <li className="flex items-center justify-center gap-2 px-4 py-6 font-mono text-2xs text-ink-subtle">
                <Spinner size={14} /> Loading…
              </li>
            )}
            {notebooks.isError && (
              <li className="px-4 py-6 text-center text-sm text-error">Couldn't load notebooks</li>
            )}
            {notebooks.data && notebookItems.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">No notebooks</li>
            )}
            {notebookItems.map((nb, i) => {
              const isActive = i === safeIndex;
              return (
                <li key={nb.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => void openNotebook(nb.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-accent-soft text-accent' : 'text-ink-base',
                    )}
                  >
                    <FileCode2
                      size={16}
                      strokeWidth={1.75}
                      className={cn('shrink-0', isActive ? 'text-accent' : 'text-ink-muted')}
                    />
                    <span className="min-w-0 flex-1 truncate">{nb.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-ink-subtle">
                      {formatRelativeTime(nb.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function CommandPalette({
  context,
  defaultLimit,
}: {
  context: { catalog: string; schema: string };
  defaultLimit: number;
}) {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  if (!open) return null;
  return (
    <PaletteContent onClose={() => setOpen(false)} context={context} defaultLimit={defaultLimit} />
  );
}

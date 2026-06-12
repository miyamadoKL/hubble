import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Command, Moon, Play, Save, Square, Sun } from 'lucide-react';
import { Logo } from './Logo';
import { NotebookTabs } from './NotebookTabs';
import { ContextSelector } from './ContextSelector';
import { UserChip } from './UserChip';
import { Button } from '../common/Button';
import { IconButton } from '../common/IconButton';
import { Kbd } from '../common/Kbd';
import { Tooltip } from '../common/Tooltip';
import { Modal } from '../common/Modal';
import { useUiStore } from '../../stores/uiStore';
import { toast } from '../common/Toast';
import {
  useNotebookStore,
  useNotebookTabs,
  runAllCells,
  cancelActiveNotebook,
  saveActiveNotebook,
} from '../../notebook';
import { useExecutionStore } from '../../execution';
import { isCellRunning } from '../../execution';

/**
 * TopBar (design.md §6): logo · notebook tabs (open/close/new/rename) ·
 * catalog.schema selector · Run all / Save · command palette · theme toggle.
 * Notebook state comes from the notebook store; run state from the execution
 * store (so the Run button flips to Stop while cells stream).
 */
export function TopBar({
  context,
  onContextChange,
  defaultLimit,
}: {
  context: { catalog: string; schema: string };
  onContextChange: (next: { catalog: string; schema: string }) => void;
  defaultLimit: number;
}) {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const togglePalette = useUiStore((s) => s.togglePalette);
  const requestSave = useUiStore((s) => s.requestSave);

  const tabs = useNotebookTabs();
  const activeId = useNotebookStore((s) => s.activeId);
  const activeCellIds = useNotebookStore(
    useShallow((s) => (activeId ? (s.open[activeId]?.notebook.cells.map((c) => c.id) ?? []) : [])),
  );

  // Reactively derive whether the active notebook has a running cell. Subscribe
  // to the cells map (stable reference between updates) and compute in render.
  const execCells = useExecutionStore((s) => s.cells);
  const running = activeCellIds.some((id) => isCellRunning(execCells[id]));

  const [closing, setClosing] = useState<{ id: string; name: string } | null>(null);

  const selectTab = (id: string) => useNotebookStore.getState().setActive(id);
  const renameTab = (id: string, name: string) =>
    useNotebookStore.getState().renameNotebook(id, name);

  const closeTab = (id: string) => {
    const entry = useNotebookStore.getState().open[id];
    if (entry?.dirty) {
      setClosing({ id, name: entry.notebook.name });
    } else {
      useNotebookStore.getState().closeNotebook(id);
    }
  };

  const onRunAll = () => {
    if (running) {
      cancelActiveNotebook();
      return;
    }
    void runAllCells(context, defaultLimit);
  };

  const onSave = async () => {
    const result = await saveActiveNotebook();
    if ('needsName' in result) requestSave('save');
  };

  return (
    <>
      <header className="flex h-13 items-center gap-4 bg-surface-raised px-4">
        <Logo />

        <div className="h-5 w-px bg-border-subtle" aria-hidden />

        <NotebookTabs
          tabs={tabs}
          activeId={activeId}
          onSelect={selectTab}
          onClose={closeTab}
          onRename={renameTab}
          onNew={() => useNotebookStore.getState().createBlankNotebook()}
        />

        <div className="ml-auto flex items-center gap-2">
          <ContextSelector
            catalog={context.catalog}
            schema={context.schema}
            onChange={onContextChange}
          />

          <div className="h-5 w-px bg-border-subtle" aria-hidden />

          <Tooltip
            label={
              <span className="flex items-center gap-1.5">
                {running ? 'Stop' : 'Run all cells'} <Kbd keys={['Ctrl', '↵']} />
              </span>
            }
          >
            <Button
              variant="primary"
              icon={running ? Square : Play}
              onClick={onRunAll}
            >
              {running ? 'Stop' : 'Run'}
            </Button>
          </Tooltip>
          <Button variant="default" icon={Save} onClick={() => void onSave()}>
            Save
          </Button>

          <div className="h-5 w-px bg-border-subtle" aria-hidden />

          <IconButton icon={Command} label="Command palette  (Ctrl K)" onClick={togglePalette} />
          <IconButton
            icon={theme === 'dark' ? Sun : Moon}
            label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            onClick={() => {
              toggleTheme();
              toast.info(theme === 'dark' ? 'Light theme' : 'Dark theme', 'Theme preference saved.');
            }}
          />

          {/* Current user (design.md §11); UserChip renders null in authMode none. */}
          <UserChip />
        </div>
      </header>

      <Modal
        open={closing !== null}
        onClose={() => setClosing(null)}
        title="Close notebook?"
        description={
          closing
            ? `“${closing.name}” has unsaved changes. Closing it will discard them.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (closing) useNotebookStore.getState().closeNotebook(closing.id);
                setClosing(null);
              }}
            >
              Discard &amp; close
            </Button>
          </>
        }
      />
    </>
  );
}

import { useEffect, useState } from 'react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { NotebookView } from '../notebook/NotebookView';
import { SaveNotebookModal } from '../notebook/SaveNotebookModal';
import { CommandPalette } from '../palette/CommandPalette';
import { PresentationView } from '../notebook/PresentationView';
import { ShortcutsHelp } from '../common/ShortcutsHelp';
import { ToastViewport } from '../common/Toast';
import { toast } from '../common/Toast';
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts';
import { useConfig, useDefaultLimit } from '../../hooks/useConfig';
import { EditorRuntimeProvider } from '../../editor/EditorRuntime';
import { useUiStore } from '../../stores/uiStore';
import {
  useActiveNotebook,
  useNotebookStore,
  useNotebookWorkspace,
  persistNewNotebook,
  persistSavedNotebook,
  readRecentContexts,
  recordRecentContext,
} from '../../notebook';

/**
 * AppShell (design.md §6): the three-zone instrument layout — TopBar over a
 * hairline, a resizable Sidebar, and the scrolling NotebookView. Owns the shared
 * catalog.schema context, bootstraps the notebook workspace (restoring open
 * tabs + drafts), and hosts the save dialog driven by the UI store's
 * `saveRequest`.
 */
export function AppShell() {
  const defaultLimit = useDefaultLimit();
  const { data: config } = useConfig();
  // Seed the shell context from the most-recently-used context (design.md §5:
  // 最近使った値を復元); config defaults fill any gap once loaded.
  const [context, setContext] = useState<{ catalog: string; schema: string }>(() => {
    const recent = readRecentContexts()[0];
    return { catalog: recent?.catalog ?? '', schema: recent?.schema ?? '' };
  });
  const [search, setSearch] = useState('');

  // Restore the previously-open notebooks (or seed a blank one).
  useNotebookWorkspace(context);
  useGlobalShortcuts();

  // Mirror the live shell context + default limit into the UI store so global
  // shortcuts (run-active-cell) execute against the same catalog.schema as the
  // toolbar without prop threading.
  const setShellRuntime = useUiStore((s) => s.setShellRuntime);
  useEffect(() => {
    setShellRuntime({ catalog: context.catalog, schema: context.schema }, defaultLimit);
  }, [context.catalog, context.schema, defaultLimit, setShellRuntime]);

  const activeId = useNotebookStore((s) => s.activeId);
  const activeEntry = useActiveNotebook();

  // Sync the shell context from two external sources — the server config and the
  // active notebook. These effects mirror external state into React (the use-case
  // the set-state-in-effect rule explicitly allows), and the functional updates
  // bail out when nothing changed, so there's no cascading-render loop.
  const activeContext = activeEntry?.notebook.context;
  useEffect(() => {
    // Adopt config defaults only when the shell still has no context (no recent,
    // no active-notebook context); never override a user choice.
    if (config) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContext((cur) => {
        if (cur.catalog || cur.schema) return cur;
        const c = config.defaults.catalog ?? '';
        const s = config.defaults.schema ?? '';
        return c || s ? { catalog: c, schema: s } : cur;
      });
    }
  }, [config]);

  useEffect(() => {
    // Adopt the active notebook's saved context when switching tabs, so the
    // selector + execution reflect the notebook the user is now editing.
    if (!activeContext || (!activeContext.catalog && !activeContext.schema)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContext((cur) => {
      const next = { catalog: activeContext.catalog ?? '', schema: activeContext.schema ?? '' };
      return cur.catalog === next.catalog && cur.schema === next.schema ? cur : next;
    });
  }, [activeContext?.catalog, activeContext?.schema, activeContext]);

  // Keep the active notebook's context in sync with the shell selector and record
  // it as most-recently-used (design.md §5: notebook context へ保存 + recent 保持).
  const handleContextChange = (next: { catalog: string; schema: string }) => {
    setContext(next);
    if (activeId) useNotebookStore.getState().setContext(activeId, next);
    recordRecentContext(next);
  };

  // ---- Help modal + presentation mode (design.md §5) ----
  const shortcutsHelpOpen = useUiStore((s) => s.shortcutsHelpOpen);
  const setShortcutsHelpOpen = useUiStore((s) => s.setShortcutsHelpOpen);
  const presentationMode = useUiStore((s) => s.presentationMode);
  const togglePresentation = useUiStore((s) => s.togglePresentation);
  // Escape exits presentation mode.
  useEffect(() => {
    if (!presentationMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') togglePresentation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentationMode, togglePresentation]);

  // ---- Save dialog (driven directly by uiStore.saveRequest) ----
  const saveRequest = useUiStore((s) => s.saveRequest);
  const clearSaveRequest = useUiStore((s) => s.clearSaveRequest);

  const closeSaveModal = () => clearSaveRequest();

  const onSaveConfirm = async (name: string) => {
    if (!activeId) return;
    const mode = saveRequest?.mode;
    closeSaveModal();
    if (mode === 'saveAs') {
      // Save As: clone the current notebook under a new name as a fresh draft.
      const entry = useNotebookStore.getState().open[activeId];
      if (!entry) return;
      const clone = {
        ...entry.notebook,
        id: `nb-${crypto.randomUUID()}`,
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      useNotebookStore.getState().openNotebook(clone, { draft: true, activate: true });
      const saved = await persistNewNotebook(clone.id, name);
      if (saved) toast.success('Saved', `“${saved.name}” saved.`);
      else toast.error('Save failed', 'Could not reach the server.');
      return;
    }
    // First save of a draft (or a draft being named).
    const entry = useNotebookStore.getState().open[activeId];
    const saved = entry?.draft
      ? await persistNewNotebook(activeId, name)
      : (useNotebookStore.getState().renameNotebook(activeId, name),
        await persistSavedNotebook(activeId));
    if (saved) toast.success('Saved', `“${saved.name}” saved.`);
    else toast.error('Save failed', 'Could not reach the server.');
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-base text-ink-base">
      <TopBar
        context={context}
        onContextChange={handleContextChange}
        defaultLimit={defaultLimit}
      />
      {/* Signature hairline under the TopBar (design.md §6 memorable detail). */}
      <div className="relative h-px shrink-0 bg-border-base">
        <span className="absolute top-0 left-0 h-px w-24 bg-gradient-to-r from-accent/60 to-transparent" />
      </div>

      <div className="flex min-h-0 flex-1">
        <Sidebar
          search={search}
          onSearchChange={setSearch}
          activeNotebookId={activeId ?? ''}
          context={context}
        />
        <main className="min-w-0 flex-1 overflow-auto bg-surface-base">
          <EditorRuntimeProvider context={context}>
            <NotebookView context={context} defaultLimit={defaultLimit} />
          </EditorRuntimeProvider>
        </main>
      </div>

      <CommandPalette context={context} defaultLimit={defaultLimit} />
      <ShortcutsHelp open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />
      {presentationMode && <PresentationView />}
      <ToastViewport />
      <SaveNotebookModal
        open={saveRequest !== null}
        initialName={activeEntry?.notebook.name ?? 'Untitled notebook'}
        title={saveRequest?.mode === 'saveAs' ? 'Save notebook as' : 'Save notebook'}
        confirmLabel={saveRequest?.mode === 'saveAs' ? 'Save a copy' : 'Save'}
        onClose={closeSaveModal}
        onConfirm={(name) => void onSaveConfirm(name)}
      />
    </div>
  );
}

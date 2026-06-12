// Workspace bootstrap (design.md §5 管理: 開いているタブ集合 + アクティブを復元,
// 未保存 notebook の下書き復元). Runs once on mount: wires the API persistence,
// restores the previously-open tabs (saved notebooks re-fetched from the server,
// drafts read back from localStorage), and seeds a blank notebook when the
// workspace is empty (design.md §1 初回起動).

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  __setPersistence,
  useNotebookStore,
  readWorkspaceSnapshot,
  readDrafts,
  blankNotebook,
} from './notebookStore';
import { __setCellSettledSink } from '../execution';
import { createNotebook, getNotebook, updateNotebook } from '../api/notebooks';

let persistenceWired = false;

/**
 * Wire the execution layer's terminal-state sink to write a lightweight summary
 * into the owning cell's `resultMeta` (design.md §4). Idempotent.
 */
function ensureResultMetaSink(): void {
  __setCellSettledSink((cellId, summary) => {
    useNotebookStore.getState().setCellResultMeta(cellId, {
      trinoQueryId: summary.trinoQueryId,
      state: summary.state,
      rowCount: summary.rowCount,
      elapsedMs: Math.max(0, Math.round(summary.elapsedMs)),
      errorMessage: summary.errorMessage,
      executedAt: summary.finishedAt,
    });
  });
}

/** Refresh the sidebar notebook list after a server-side change. */
function invalidateList(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['notebooks', 'list'] });
}

/** Wire the real notebook API into the store (idempotent). */
function ensurePersistence(queryClient: QueryClient): void {
  if (persistenceWired) return;
  persistenceWired = true;
  __setPersistence({
    create: async (nb) => {
      const saved = await createNotebook({
        name: nb.name,
        description: nb.description,
        cells: nb.cells,
        variables: nb.variables,
        context: nb.context,
      });
      invalidateList(queryClient);
      return saved;
    },
    update: async (id, nb) => {
      const saved = await updateNotebook(id, {
        name: nb.name,
        description: nb.description,
        cells: nb.cells,
        variables: nb.variables,
        context: nb.context,
      });
      invalidateList(queryClient);
      return saved;
    },
  });
}

/**
 * Module-level latch so the one-time workspace restore runs to completion exactly
 * once across React StrictMode's dev double-mount. (Restore re-fetches saved
 * notebooks from the server, reads drafts from localStorage, and opens a blank
 * notebook when nothing can be restored.)
 *
 * A `useRef` guard isn't enough: StrictMode mounts → unmounts → remounts, and an
 * effect-cleanup `cancelled` flag would abort the first (discarded) mount's
 * in-flight async restore *after* its await resolved, while the surviving mount
 * skipped restore via the ref. The result was an empty workspace on reload.
 * Writing into the (singleton) notebook store is safe regardless of which mount
 * "owns" the call, so we simply ensure the async restore is kicked off once and
 * never cancelled mid-flight.
 */
let workspaceRestoreStarted = false;

export function useNotebookWorkspace(defaultContext: { catalog?: string; schema?: string }): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (workspaceRestoreStarted) return;
    workspaceRestoreStarted = true;
    ensurePersistence(queryClient);
    ensureResultMetaSink();

    const store = useNotebookStore.getState();
    // Already populated (e.g. fast refresh) — nothing to do.
    if (store.openIds.length > 0) return;

    const snapshot = readWorkspaceSnapshot();
    const drafts = readDrafts();
    const draftIds = new Set(drafts.map((d) => d.id));

    async function restore(): Promise<void> {
      if (!snapshot || snapshot.openIds.length === 0) {
        useNotebookStore.getState().openNotebook(blankNotebook(defaultContext), {
          draft: true,
          activate: true,
        });
        return;
      }

      // Re-open in the original order. Drafts come from localStorage; the rest
      // are fetched from the server (dropped if 404 / gone).
      for (const id of snapshot.openIds) {
        if (draftIds.has(id)) {
          const draft = drafts.find((d) => d.id === id);
          if (draft) {
            useNotebookStore.getState().openNotebook(draft, { draft: true, activate: false });
          }
        } else {
          try {
            const nb = await getNotebook(id);
            useNotebookStore.getState().openNotebook(nb, { draft: false, activate: false });
          } catch {
            /* gone — skip */
          }
        }
      }

      const s = useNotebookStore.getState();
      if (s.openIds.length === 0) {
        // Everything was gone — fall back to a blank notebook.
        s.openNotebook(blankNotebook(defaultContext), { draft: true, activate: true });
      } else {
        // Re-point active to the previously-active tab if it survived.
        const active =
          snapshot.activeId && s.open[snapshot.activeId] ? snapshot.activeId : s.openIds[0]!;
        s.setActive(active);
      }
    }

    void restore();
    // defaultContext is read once at bootstrap; restore must not re-run on its
    // identity changing, so it is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

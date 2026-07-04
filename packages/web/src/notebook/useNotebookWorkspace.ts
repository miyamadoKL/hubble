// Workspace bootstrap (restores the open tab set + active tab, and unsaved
// notebook drafts). Runs once on mount: wires the API persistence,
// restores the previously-open tabs (saved notebooks re-fetched from the server,
// drafts read back from localStorage), and seeds a blank notebook when the
// workspace is empty.
//
// ==== ファイルの責務（日本語） ================================================
// アプリ起動時に一度だけ実行される、notebook ワークスペースの復元処理
// （開いているタブ集合とアクティブタブの復元、未保存 draft notebook の下書き復元）。
//   1. notebookStore に本物の API 永続化実装（create/update）を配線する。
//   2. execution レイヤーの「セル実行が終端状態に達した」通知を、notebook の
//      resultMeta へ書き込むシンクとして配線する。
//   3. localStorage に保存されたワークスペーススナップショット（開いていた
//      タブ id 一覧 + アクティブ id）を読み、保存済み notebook はサーバーから
//      再取得、draft notebook は localStorage から読み戻して、元通りにタブを
//      再オープンする。
//   4. 復元できるものが何も無ければ、空の notebook を 1 つ新規作成して開く。
// ============================================================================

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

// モジュールスコープのフラグ: persistence の配線は 1 度だけ行えばよい
// （複数回 useNotebookWorkspace が呼ばれても再配線しない）。
let persistenceWired = false;

/**
 * Wire the execution layer's terminal-state sink to write a lightweight summary
 * into the owning cell's `resultMeta`. Idempotent.
 *
 * execution レイヤーが「セルの実行が終端状態に達した」ときに呼ぶシンクを、
 * notebook ストアの `setCellResultMeta` へ接続する。これにより実行結果の
 * 軽量なサマリー（resultMeta）がセルに永続化される。
 * 何度呼んでも安全（後勝ちで同じ実装が再設定されるだけ）。
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
/** サーバー側の変更後に、サイドバーの notebook 一覧クエリを再取得させる。 */
function invalidateList(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['notebooks', 'list'] });
}

/** Wire the real notebook API into the store (idempotent). */
/**
 * notebook ストアへ、実際の notebook API（create/update）を配線する
 * （`persistenceWired` フラグにより 1 度だけ実行される）。保存が成功する
 * たびにサイドバーの notebook 一覧を無効化して最新化する。
 */
function ensurePersistence(queryClient: QueryClient): void {
  if (persistenceWired) return;
  persistenceWired = true;
  __setPersistence({
    create: async (nb) => {
      // draft の初回保存（POST 相当）。
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
      // 保存済み notebook の更新（PUT 相当。オートセーブ/明示保存の両方から使われる）。
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
 *
 * モジュールスコープのラッチ変数。React の開発時 StrictMode は effect を
 * マウント→アンマウント→再マウントと二重実行するため、`useRef` によるガード
 * だけでは不十分（1 回目の破棄されるマウントの非同期復元処理が、await の
 * 解決後にクリーンアップの `cancelled` フラグで中断され、生き残った 2 回目の
 * マウント側は ref を見て復元をスキップしてしまい、結果としてリロード後の
 * ワークスペースが空になるというバグが起きていた）。notebook ストア自体は
 * シングルトンであり、どちらのマウントが書き込んでも安全なため、単純に
 * 「非同期復元処理を 1 回だけキックし、途中でキャンセルしない」という
 * モジュールスコープのフラグで解決している。
 */
let workspaceRestoreStarted = false;

/**
 * アプリ起動時にワークスペース（開いていた notebook タブ群）を復元する副作用
 * フック。API 永続化の配線、resultMeta シンクの配線、タブの再オープンを
 * 1 度だけ行う（React StrictMode の開発時二重マウントに対しても安全。
 * 詳細は `workspaceRestoreStarted` のコメントを参照）。
 */
export function useNotebookWorkspace(defaultContext: { catalog?: string; schema?: string }): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    // モジュールスコープのラッチにより、StrictMode の二重マウントでも
    // 復元処理は 1 回しか開始されない。
    if (workspaceRestoreStarted) return;
    workspaceRestoreStarted = true;
    ensurePersistence(queryClient);
    ensureResultMetaSink();

    const store = useNotebookStore.getState();
    // Already populated (e.g. fast refresh) — nothing to do.
    // 既にタブが存在する場合（Fast Refresh など）は復元不要。
    if (store.openIds.length > 0) return;

    // ワークスペーススナップショット（開いていたタブ id 群 + アクティブ id）と
    // draft notebook の実体を、両方とも localStorage から読み出す。
    const snapshot = readWorkspaceSnapshot();
    const drafts = readDrafts();
    const draftIds = new Set(drafts.map((d) => d.id));

    async function restore(): Promise<void> {
      if (!snapshot || snapshot.openIds.length === 0) {
        // 復元すべきスナップショットが無い（初回起動）: 空の notebook を開く。
        useNotebookStore.getState().openNotebook(blankNotebook(defaultContext), {
          draft: true,
          activate: true,
        });
        return;
      }

      // Re-open in the original order. Drafts come from localStorage; the rest
      // are fetched from the server (dropped if 404 / gone).
      // 元の並び順でタブを再オープンする。draft は localStorage から、それ以外は
      // サーバーから再取得する（404 等で存在しなければそのタブは諦めて飛ばす）。
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
        // 復元しようとしたタブが 1 つも生き残らなかった場合、空の notebook にフォールバックする。
        s.openNotebook(blankNotebook(defaultContext), { draft: true, activate: true });
      } else {
        // Re-point active to the previously-active tab if it survived.
        // 直前のアクティブタブが生き残っていればそれを再度アクティブにし、
        // 無ければ先頭のタブをアクティブにする。
        const active =
          snapshot.activeId && s.open[snapshot.activeId] ? snapshot.activeId : s.openIds[0]!;
        s.setActive(active);
      }
    }

    void restore();
    // defaultContext is read once at bootstrap; restore must not re-run on its
    // identity changing, so it is intentionally excluded.
    // defaultContext は起動時に一度だけ読めばよく、その参照が変わるたびに
    // 復元処理を再実行すべきではないため、意図的に依存配列から除外している。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

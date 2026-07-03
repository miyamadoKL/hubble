/**
 * アプリ全体のシェル（TopBar + Sidebar + NotebookView の3ゾーン構成）を組み立てるルートコンポーネント。
 * catalog.schema コンテキストの一元管理、ノートブックワークスペースの復元、グローバルショートカット、
 * 保存ダイアログ、コマンドパレット、プレゼンテーションモード等、画面全体を横断する配線をここに集約する。
 */
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
import { useDatasources } from '../../hooks/useDatasources';
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
/**
 * アプリのルートシェルコンポーネント。props は取らず、内部で context（catalog/schema）、
 * ノートブックワークスペース、保存ダイアログ、ヘルプ/プレゼンテーションモードなどの
 * 画面横断状態をすべて所有する。
 */
export function AppShell() {
  const defaultLimit = useDefaultLimit();
  const { data: config } = useConfig();
  const { selectedId: datasourceId, selected: selectedDatasource } = useDatasources();
  // Seed the shell context from the most-recently-used context (design.md §5:
  // 最近使った値を復元); config defaults fill any gap once loaded.
  // シェル全体で共有する catalog.schema コンテキスト。初期値は localStorage の「最近使った
  // コンテキスト」の先頭要素から復元し、なければ空文字（後続の useEffect が config の
  // デフォルト値で補う）。
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
  // props のバケツリレーを避けるため、最新の context/defaultLimit を uiStore にも
  // 反映しておく。グローバルショートカット側はこの store 経由で同じ実行条件を参照する。
  const setShellRuntime = useUiStore((s) => s.setShellRuntime);
  useEffect(() => {
    setShellRuntime(
      { catalog: context.catalog, schema: context.schema, datasourceId },
      defaultLimit,
    );
  }, [context.catalog, context.schema, datasourceId, defaultLimit, setShellRuntime]);

  const activeId = useNotebookStore((s) => s.activeId);
  const activeEntry = useActiveNotebook();

  // Sync the shell context from two external sources — the server config and the
  // active notebook. These effects mirror external state into React (the use-case
  // the set-state-in-effect rule explicitly allows), and the functional updates
  // bail out when nothing changed, so there's no cascading-render loop.
  // シェルの context を「サーバー設定」と「アクティブなノートブック」という2つの外部要因に
  // 同期させる2つの useEffect。どちらも外部状態を React state へ反映するだけの用途であり、
  // 変更がなければ同一参照を返す（return cur）ことで無限レンダーループを避けている。
  const activeContext = activeEntry?.notebook.context;
  useEffect(() => {
    // Adopt config defaults only when the shell still has no context (no recent,
    // no active-notebook context); never override a user choice.
    // シェルにまだ context がない場合（最近使った履歴もアクティブノートブックの context も
    // ない場合）に限り、サーバー設定のデフォルト値を採用する。ユーザーが既に選択済みの
    // context は絶対に上書きしない。
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
    // タブを切り替えたときに、そのノートブックに保存されている context を採用し、
    // セレクター表示とセル実行が「今編集しているノートブック」と一致するようにする。
    if (!activeContext || (!activeContext.catalog && !activeContext.schema)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContext((cur) => {
      const next = { catalog: activeContext.catalog ?? '', schema: activeContext.schema ?? '' };
      return cur.catalog === next.catalog && cur.schema === next.schema ? cur : next;
    });
  }, [activeContext?.catalog, activeContext?.schema, activeContext]);

  // Keep the active notebook's context in sync with the shell selector and record
  // it as most-recently-used (design.md §5: notebook context へ保存 + recent 保持).
  // ContextSelector から呼ばれるハンドラー。シェルの context を更新し、アクティブな
  // ノートブックにも同じ context を書き込み、さらに「最近使った」履歴にも記録する。
  const handleContextChange = (next: { catalog: string; schema: string }) => {
    setContext(next);
    if (activeId) useNotebookStore.getState().setContext(activeId, next);
    recordRecentContext(next);
  };

  // ---- Help modal + presentation mode (design.md §5) ----
  // ---- ヘルプモーダルとプレゼンテーションモード ----
  const shortcutsHelpOpen = useUiStore((s) => s.shortcutsHelpOpen);
  const setShortcutsHelpOpen = useUiStore((s) => s.setShortcutsHelpOpen);
  const presentationMode = useUiStore((s) => s.presentationMode);
  const togglePresentation = useUiStore((s) => s.togglePresentation);
  // Escape exits presentation mode.
  // プレゼンテーションモード中のみ Escape キーのリスナーを登録し、押されたらモードを抜ける。
  useEffect(() => {
    if (!presentationMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') togglePresentation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentationMode, togglePresentation]);

  // ---- Save dialog (driven directly by uiStore.saveRequest) ----
  // ---- 保存ダイアログ（uiStore.saveRequest によって直接駆動される） ----
  const saveRequest = useUiStore((s) => s.saveRequest);
  const clearSaveRequest = useUiStore((s) => s.clearSaveRequest);

  // 保存ダイアログを閉じる（保存リクエスト自体をクリアする）。
  const closeSaveModal = () => clearSaveRequest();

  // 保存ダイアログで名前が確定されたときの処理。
  // saveRequest.mode によって「名前を付けて複製保存（saveAs）」と
  // 「新規ドラフトの初回保存 / 既存ノートブックの改名保存」の2系統に分岐する。
  const onSaveConfirm = async (name: string) => {
    if (!activeId) return;
    const mode = saveRequest?.mode;
    closeSaveModal();
    if (mode === 'saveAs') {
      // Save As: clone the current notebook under a new name as a fresh draft.
      // 「名前を付けて保存」: 現在のノートブックを新しいIDでクローンし、
      // 新規ドラフトとして開いた上でサーバーに保存する。
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
    // ドラフトの初回保存、またはドラフトへ名前を付ける操作。ドラフトなら新規作成として
    // 保存し、既存ノートブックであれば改名してから保存する。
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
      {/* 最上部の TopBar。context の表示/変更と全セル実行のデフォルト行数上限を渡す。 */}
      <TopBar
        context={context}
        onContextChange={handleContextChange}
        defaultLimit={defaultLimit}
      />
      {/* Signature hairline under the TopBar (design.md §6 memorable detail). */}
      {/* TopBar 直下の1px の装飾ライン。左端だけアクセントカラーのグラデーションを乗せる。 */}
      <div className="relative h-px shrink-0 bg-border-base">
        <span className="absolute top-0 left-0 h-px w-24 bg-gradient-to-r from-accent/60 to-transparent" />
      </div>

      {/* 本体: 左に Sidebar、右に NotebookView（エディタランタイム配下）を配置する2カラム。 */}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          search={search}
          onSearchChange={setSearch}
          activeNotebookId={activeId ?? ''}
          context={context}
          datasourceId={datasourceId}
          flattenCatalog={selectedDatasource ? !selectedDatasource.capabilities.catalogs : false}
        />
        <main className="min-w-0 flex-1 overflow-auto bg-surface-base">
          {datasourceId && (
            <EditorRuntimeProvider
              context={context}
              datasourceId={datasourceId}
              datasourceKind={selectedDatasource?.kind ?? 'trino'}
            >
              <NotebookView
                context={{ ...context, datasourceId }}
                defaultLimit={defaultLimit}
                costEstimateEnabled={selectedDatasource?.capabilities.costEstimate ?? false}
                trinoLanguage={selectedDatasource?.kind === 'trino'}
              />
            </EditorRuntimeProvider>
          )}
        </main>
      </div>

      {/* 画面横断のオーバーレイ群: コマンドパレット、ショートカットヘルプ、
          プレゼンテーションモード（有効時のみ描画）、トースト通知。 */}
      <CommandPalette
        context={{ ...context, datasourceId }}
        defaultLimit={defaultLimit}
      />
      <ShortcutsHelp open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />
      {presentationMode && <PresentationView />}
      <ToastViewport />
      {/* 保存ダイアログ。uiStore.saveRequest が非 null のときだけ開く。
          mode によってタイトル/確定ボタンのラベルが「保存」「名前を付けて保存」で切り替わる。 */}
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

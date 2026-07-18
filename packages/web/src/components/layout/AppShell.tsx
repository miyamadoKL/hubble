/**
 * アプリ全体のシェル（TopBar + Sidebar + NotebookView の3ゾーン構成）を組み立てるルートコンポーネント。
 * catalog.schema コンテキストの一元管理、ノートブックワークスペースの復元、グローバルショートカット、
 * 保存ダイアログ、コマンドパレット、プレゼンテーションモード等、画面全体を横断する配線をここに集約する。
 */
import { useEffect, useState } from 'react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { AiPanel } from '../ai/AiPanel';
import { NotebookView } from '../notebook/NotebookView';
import { WorkflowView } from '../workflow/WorkflowView';
import { DashboardView } from '../dashboard/DashboardView';
import { SaveNotebookModal } from '../notebook/SaveNotebookModal';
import { CommandPalette } from '../palette/CommandPalette';
import { PresentationView } from '../notebook/PresentationView';
import { ShortcutsHelp } from '../common/ShortcutsHelp';
import { ToastViewport } from '../common/Toast';
import { toast } from '../common/Toast';
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts';
import { useConfig, useDefaultLimit } from '../../hooks/useConfig';
import { useDatasources } from '../../hooks/useDatasources';
import { useMe } from '../../hooks/useMe';
import { hasPermission } from '../../permissions';
import { EditorRuntimeProvider } from '../../editor/EditorRuntime';
import { useUiStore } from '../../stores/uiStore';
import { useDatasourceStore, type ExecutionContext } from '../../stores/datasourceStore';
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
 * アプリのルートシェルコンポーネント。props は取らず、内部で context（catalog/schema）、
 * ノートブックワークスペース、保存ダイアログ、ヘルプ/プレゼンテーションモードなどの
 * 画面横断状態をすべて所有する。
 */
export function AppShell() {
  const defaultLimit = useDefaultLimit();
  const { data: config } = useConfig();
  const { datasources, selectedId: datasourceId, selected: selectedDatasource } = useDatasources();
  // datasource、catalog、schema は単一ストアの1値として更新し、異なる世代の組を描画しない。
  const executionContext = useDatasourceStore((state) => state.executionContext);
  const setExecutionContext = useDatasourceStore((state) => state.setExecutionContext);
  const context = { catalog: executionContext.catalog, schema: executionContext.schema };
  const [search, setSearch] = useState('');

  // 直前に開いていたノートブック群を復元する（何もなければ空のノートブックを1つ用意する）。
  useNotebookWorkspace(context);
  useGlobalShortcuts();

  // props のバケツリレーを避けるため、最新の context/defaultLimit を uiStore にも
  // 反映しておく。グローバルショートカット側はこの store 経由で同じ実行条件を参照する。
  const setShellRuntime = useUiStore((s) => s.setShellRuntime);
  useEffect(() => {
    setShellRuntime(executionContext, defaultLimit);
  }, [executionContext, defaultLimit, setShellRuntime]);

  const activeId = useNotebookStore((s) => s.activeId);
  const activeEntry = useActiveNotebook();

  // シェルの context を「サーバー設定」と「アクティブなノートブック」という2つの外部要因に
  // 同期させる2つの useEffect。どちらも外部状態を React state へ反映するだけの用途であり、
  // 変更がなければ同一参照を返す（return cur）ことで無限レンダーループを避けている。
  const activeContext = activeEntry?.notebook.context;
  useEffect(() => {
    // シェルにまだ context がない場合（最近使った履歴もアクティブノートブックの context も
    // ない場合）に限り、サーバー設定のデフォルト値を採用する。ユーザーが既に選択済みの
    // context は絶対に上書きしない。
    if (!config || !datasourceId || executionContext.catalog || executionContext.schema) return;
    const catalog = config.defaults.catalog ?? '';
    const schema = config.defaults.schema ?? '';
    if (!catalog && !schema) return;
    setExecutionContext({ datasourceId, catalog, schema });
  }, [
    config,
    datasourceId,
    executionContext.catalog,
    executionContext.schema,
    setExecutionContext,
  ]);

  useEffect(() => {
    // タブを切り替えたときに、そのノートブックに保存されている context を採用し、
    // セレクター表示とセル実行が「今編集しているノートブック」と一致するようにする。
    if (
      !activeContext ||
      (!activeContext.datasourceId && !activeContext.catalog && !activeContext.schema)
    ) {
      return;
    }
    const nextDatasourceId = activeContext.datasourceId ?? datasourceId;
    if (!nextDatasourceId) return;
    if (
      activeContext.datasourceId &&
      !datasources.some((datasource) => datasource.id === activeContext.datasourceId)
    ) {
      return;
    }
    const next: ExecutionContext = {
      datasourceId: nextDatasourceId,
      catalog: activeContext.catalog ?? '',
      schema: activeContext.schema ?? '',
    };
    if (
      executionContext.datasourceId === next.datasourceId &&
      executionContext.catalog === next.catalog &&
      executionContext.schema === next.schema
    ) {
      return;
    }
    setExecutionContext(next);
  }, [
    activeContext,
    activeContext?.catalog,
    activeContext?.datasourceId,
    activeContext?.schema,
    datasourceId,
    datasources,
    executionContext.catalog,
    executionContext.datasourceId,
    executionContext.schema,
    setExecutionContext,
  ]);

  // ContextSelector から呼ばれるハンドラー。シェルの context を更新し、アクティブな
  // ノートブックにも同じ context を書き込み、さらに「最近使った」履歴にも記録する。
  const handleContextChange = (next: { catalog: string; schema: string }) => {
    if (!datasourceId) return;
    const resolved = { datasourceId, ...next };
    setExecutionContext(resolved);
    if (activeId) useNotebookStore.getState().setContext(activeId, resolved);
    recordRecentContext(resolved);
  };

  /** データソース切替時に、そのデータソース固有の直近コンテキストも同時に復元する。 */
  const handleDatasourceChange = (nextDatasourceId: string) => {
    const recent = readRecentContexts(nextDatasourceId)[0];
    const next: ExecutionContext = {
      datasourceId: nextDatasourceId,
      catalog: recent?.catalog ?? '',
      schema: recent?.schema ?? '',
    };
    setExecutionContext(next);
    if (activeId) useNotebookStore.getState().setContext(activeId, next);
  };

  // ---- AI アシスタントパネル ----
  // server 設定で AI が有効、かつ ai.use 権限を持ち、パネルが開かれている場合のみ描画する。
  const { data: me } = useMe();
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const showAiPanel = aiPanelOpen && (config?.ai.enabled ?? false) && hasPermission(me, 'ai.use');

  // ---- ヘルプモーダルとプレゼンテーションモード ----
  const workflowView = useUiStore((s) => s.workflowView);
  const dashboardView = useUiStore((s) => s.dashboardView);
  const shortcutsHelpOpen = useUiStore((s) => s.shortcutsHelpOpen);
  const setShortcutsHelpOpen = useUiStore((s) => s.setShortcutsHelpOpen);
  const presentationMode = useUiStore((s) => s.presentationMode);
  const togglePresentation = useUiStore((s) => s.togglePresentation);
  // プレゼンテーションモード中のみ Escape キーのリスナーを登録し、押されたらモードを抜ける。
  useEffect(() => {
    if (!presentationMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') togglePresentation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentationMode, togglePresentation]);

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
        context={executionContext}
        onDatasourceChange={handleDatasourceChange}
        onContextChange={handleContextChange}
        defaultLimit={defaultLimit}
      />
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
          datasourceId={executionContext.datasourceId ?? datasourceId}
          flattenCatalog={selectedDatasource ? !selectedDatasource.capabilities.catalogs : false}
        />
        <main className="min-w-0 flex-1 overflow-auto bg-surface-base">
          {/* ワークフロー/ダッシュボードビューが開かれている間はノートブックの代わりに表示する。 */}
          {workflowView ? (
            <WorkflowView />
          ) : dashboardView ? (
            <DashboardView />
          ) : (
            executionContext.datasourceId && (
              <EditorRuntimeProvider
                context={context}
                datasourceId={executionContext.datasourceId}
                datasourceKind={selectedDatasource?.kind ?? 'trino'}
              >
                <NotebookView
                  context={executionContext}
                  defaultLimit={defaultLimit}
                  costEstimateEnabled={selectedDatasource?.capabilities.costEstimate ?? false}
                  trinoLanguage={selectedDatasource?.kind === 'trino'}
                />
              </EditorRuntimeProvider>
            )
          )}
        </main>
        {/* AI アシスタントパネル（メインエリアの右側）。 */}
        {showAiPanel && <AiPanel />}
      </div>

      {/* 画面横断のオーバーレイ群: コマンドパレット、ショートカットヘルプ、
          プレゼンテーションモード（有効時のみ描画）、トースト通知。 */}
      <CommandPalette context={executionContext} defaultLimit={defaultLimit} />
      <ShortcutsHelp open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />
      {presentationMode && <PresentationView />}
      <ToastViewport />
      {/* 保存ダイアログ。uiStore.saveRequest が非 null のときだけ開く。
          mode によってタイトル/確定ボタンのラベルが「保存」「名前を付けて保存」で切り替わる。 */}
      <SaveNotebookModal
        open={saveRequest !== null}
        targetId={activeId}
        initialName={activeEntry?.notebook.name ?? 'Untitled notebook'}
        title={saveRequest?.mode === 'saveAs' ? 'Save notebook as' : 'Save notebook'}
        confirmLabel={saveRequest?.mode === 'saveAs' ? 'Save a copy' : 'Save'}
        onClose={closeSaveModal}
        onConfirm={(name) => void onSaveConfirm(name)}
      />
    </div>
  );
}

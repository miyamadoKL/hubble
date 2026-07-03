/**
 * アプリ最上部の TopBar コンポーネント。
 * ロゴ、開いているノートブックのタブ列、catalog.schema コンテキストセレクター、
 * 全セル実行/停止ボタンと保存ボタン、コマンドパレット起動、テーマ切り替え、
 * 現在のユーザー表示までを1本の横並びバーにまとめる、シェルの中心的な UI 部品。
 */
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Command, Moon, Play, Save, Square, Sun } from 'lucide-react';
import { Logo } from './Logo';
import { NotebookTabs } from './NotebookTabs';
import { ContextSelector } from './ContextSelector';
import { DatasourceSelector } from './DatasourceSelector';
import { useDatasources } from '../../hooks/useDatasources';
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
/**
 * TopBar 本体コンポーネント。
 * ノートブック関連の状態は notebook store から、実行中かどうかは execution store から
 * それぞれ購読する。context（catalog/schema）と defaultLimit は AppShell から props で
 * 受け取り、変更や実行のたびに親へコールバックまたはグローバル操作関数で通知する。
 *
 * @param context - 現在の catalog / schema コンテキスト。ContextSelector の表示値になる。
 * @param onContextChange - コンテキストが変更されたときに呼ばれるコールバック（親が保存する）。
 * @param defaultLimit - 全セル実行時に適用するデフォルトの行数上限。
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
  // テーマ（ライト/ダーク）とコマンドパレットの開閉、保存ダイアログのリクエストは
  // すべて uiStore（グローバル UI 状態）から取得する。
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const togglePalette = useUiStore((s) => s.togglePalette);
  const requestSave = useUiStore((s) => s.requestSave);

  // 開いているノートブックのタブ一覧とアクティブなノートブックID。
  const tabs = useNotebookTabs();
  const activeId = useNotebookStore((s) => s.activeId);
  // アクティブなノートブックが持つセルIDの一覧（実行中判定に使う）。
  const activeCellIds = useNotebookStore(
    useShallow((s) => (activeId ? (s.open[activeId]?.notebook.cells.map((c) => c.id) ?? []) : [])),
  );

  // Reactively derive whether the active notebook has a running cell. Subscribe
  // to the cells map (stable reference between updates) and compute in render.
  // アクティブなノートブックのいずれかのセルが実行中かどうかを毎レンダーで計算する
  // （Run ボタンを Stop 表示に切り替えるための派生値）。
  const execCells = useExecutionStore((s) => s.cells);
  const running = activeCellIds.some((id) => isCellRunning(execCells[id]));

  const {
    datasources,
    selectedId,
    setSelectedId,
    isLoading: datasourcesLoading,
  } = useDatasources();

  // 「未保存のノートブックを閉じようとしている」ときに表示する確認モーダルの対象
  // （id と表示名）。null なら確認モーダルは非表示。
  const [closing, setClosing] = useState<{ id: string; name: string } | null>(null);

  // タブ選択と改名は notebook store の操作をそのまま呼び出す薄いラッパー。
  const selectTab = (id: string) => useNotebookStore.getState().setActive(id);
  const renameTab = (id: string, name: string) =>
    useNotebookStore.getState().renameNotebook(id, name);

  // タブを閉じる。未保存の変更がある場合は即座に閉じず、確認モーダルを開く。
  // 変更がなければそのまま notebook store から閉じる。
  const closeTab = (id: string) => {
    const entry = useNotebookStore.getState().open[id];
    if (entry?.dirty) {
      setClosing({ id, name: entry.notebook.name });
    } else {
      useNotebookStore.getState().closeNotebook(id);
    }
  };

  // Run/Stop ボタンのクリック処理。実行中ならキャンセル、そうでなければ
  // 現在の context と defaultLimit で全セルを実行する。
  const onRunAll = () => {
    if (running) {
      cancelActiveNotebook();
      return;
    }
    void runAllCells({ ...context, datasourceId: selectedId }, defaultLimit);
  };

  // Save ボタンのクリック処理。まだ名前が付いていない（新規未保存）ノートブックの
  // 場合は名前入力を要求する保存ダイアログを開き、それ以外はそのまま保存する。
  const onSave = async () => {
    const result = await saveActiveNotebook();
    if ('needsName' in result) requestSave('save');
  };

  return (
    <>
      <header className="flex h-13 items-center gap-4 bg-surface-raised px-4">
        {/* 左端: プロダクトロゴ。 */}
        <Logo />

        <div className="h-5 w-px bg-border-subtle" aria-hidden />

        {/* 開いているノートブックのタブ列と新規タブ追加ボタン。 */}
        <NotebookTabs
          tabs={tabs}
          activeId={activeId}
          onSelect={selectTab}
          onClose={closeTab}
          onRename={renameTab}
          onNew={() => useNotebookStore.getState().createBlankNotebook()}
        />

        {/* 右寄せグループ: コンテキスト選択、実行/保存、パレット/テーマ、ユーザー表示。 */}
        <div className="ml-auto flex items-center gap-2">
          <DatasourceSelector
            datasources={datasources}
            selectedId={selectedId}
            onChange={setSelectedId}
            loading={datasourcesLoading}
          />
          {/* catalog.schema コンテキストの選択 UI。 */}
          <ContextSelector
            datasourceId={selectedId}
            catalog={context.catalog}
            schema={context.schema}
            onChange={onContextChange}
          />

          <div className="h-5 w-px bg-border-subtle" aria-hidden />

          {/* 全セル実行/停止ボタン。実行中かどうかでアイコンとラベルを切り替える。 */}
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
          {/* アクティブなノートブックを保存するボタン。 */}
          <Button variant="default" icon={Save} onClick={() => void onSave()}>
            Save
          </Button>

          <div className="h-5 w-px bg-border-subtle" aria-hidden />

          {/* コマンドパレットの起動ボタン。 */}
          <IconButton icon={Command} label="Command palette  (Ctrl K)" onClick={togglePalette} />
          {/* ライト/ダークテーマの切り替えボタン。切り替え時にトースト通知も出す。 */}
          <IconButton
            icon={theme === 'dark' ? Sun : Moon}
            label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            onClick={() => {
              toggleTheme();
              toast.info(theme === 'dark' ? 'Light theme' : 'Dark theme', 'Theme preference saved.');
            }}
          />

          {/* Current user (design.md §11); UserChip renders null in authMode none. */}
          {/* 現在のユーザー表示。authMode が none のときは UserChip 内部で null を返す。 */}
          <UserChip />
        </div>
      </header>

      {/* 未保存のノートブックを閉じようとしたときに表示する確認モーダル。 */}
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

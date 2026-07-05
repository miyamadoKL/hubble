/**
 * ワークフロー一覧パネル (アシストサイドバー内)。
 *
 * 登録済みワークフローを一覧表示し、各行に最終実行のステータスバッジ、
 * cron または manual の実行方式、次回実行予定を表示する。行クリックで
 * メインエリアのワークフロービュー (WorkflowView) を開く。新規作成ボタンは
 * 新規作成ビューを開くだけで、フォーム自体はメインエリア側が持つ。
 * 一覧は useWorkflows フック側でポーリングされ、実行中の run の完了が
 * 自動で反映される。
 */
import { useMemo } from 'react';
import type { Workflow } from '@hubble/contracts';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Button } from '../common/Button';
import { useWorkflows } from '../../hooks/useWorkflows';
import { useUiStore } from '../../stores/uiStore';
import { useDatasources } from '../../hooks/useDatasources';
import { DatasourceBadge } from '../common/DatasourceBadge';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';
import { nextRunLabel, totalSteps, draftFromWorkflow } from './workflowFormat';
import { cn } from '../../utils/cn';

/**
 * ワークフロー一覧の 1 行分を描画するコンポーネント。
 * 名前、最終実行ステータス、実行方式 (cron / manual)、次回実行予定を表示する。
 * @param workflow 表示対象のワークフロー。
 * @param now 次回実行の相対表示に使う現在時刻。
 * @param active 現在メインエリアで開かれているかどうか (行のハイライトに使う)。
 * @param onOpen 行クリック時にワークフロービューを開くコールバック。
 */
function WorkflowRow({
  workflow,
  now,
  active,
  datasources,
  onOpen,
}: {
  workflow: Workflow;
  now: Date;
  active: boolean;
  datasources: ReturnType<typeof useDatasources>['datasources'];
  onOpen: () => void;
}) {
  const steps = totalSteps(draftFromWorkflow(workflow));
  return (
    <li className="border-b border-border-subtle">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active || undefined}
        className={cn(
          'flex w-full flex-col gap-1.5 px-3 py-2.5 text-left transition-colors',
          active ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
        )}
      >
        <span className="flex items-center gap-2">
          <WorkflowIcon
            size={15}
            strokeWidth={1.75}
            className={cn('shrink-0', active ? 'text-accent' : 'text-ink-muted')}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-medium',
              active ? 'text-accent' : 'text-ink-strong',
            )}
          >
            {workflow.name}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 pl-6">
          {workflow.lastRun ? (
            <WorkflowStatusBadge status={workflow.lastRun.status} />
          ) : (
            <span className="font-mono text-2xs text-ink-subtle">never run</span>
          )}
          <DatasourceBadge datasourceId={workflow.datasourceId} datasources={datasources} />
          <span className="font-mono text-2xs text-ink-subtle">
            {steps} step{steps === 1 ? '' : 's'}
          </span>
          {/* cron 設定があれば次回予定、なければ手動のみであることを表示する。 */}
          <span className="font-mono text-2xs text-ink-subtle">
            {workflow.cron ? `next ${nextRunLabel(workflow, now)}` : 'manual only'}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * ワークフローパネル本体。
 * @param search 検索語 (親コンポーネントの検索ボックスから渡される)。
 *   名前または説明への部分一致 (大文字小文字無視) でクライアント側絞り込みを行う。
 */
export function WorkflowsPanel({ search }: { search: string }) {
  const list = useWorkflows();
  const { datasources } = useDatasources();
  const workflowView = useUiStore((s) => s.workflowView);
  const openWorkflow = useUiStore((s) => s.openWorkflow);
  const openNewWorkflow = useUiStore((s) => s.openNewWorkflow);
  const now = new Date();

  // 検索語で絞り込み、名前順に並べ替える。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = list.data ?? [];
    const matched = q
      ? items.filter(
          (w) => w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q),
        )
      : items;
    return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  }, [list.data, search]);

  // 初回取得中はローディング表示のみを返す。
  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  // 取得エラー時の空状態表示。
  if (list.isError) {
    return (
      <EmptyState
        icon={WorkflowIcon}
        title="Couldn't load workflows"
        description="The server didn't respond."
        compact
      />
    );
  }

  return (
    <div className="flex flex-col">
      {/* 新規作成ボタン。メインエリアの新規作成ビューを開く。 */}
      <div className="px-3 pb-2">
        <Button
          variant="default"
          size="sm"
          icon={Plus}
          onClick={openNewWorkflow}
          className="w-full justify-center"
        >
          New workflow
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={WorkflowIcon}
          title={search.trim() ? 'No matches' : 'No workflows'}
          description={
            search.trim()
              ? 'Try a different search term.'
              : 'Chain queries into stages and run them together.'
          }
          compact
        />
      ) : (
        <ul className="flex flex-col">
          {filtered.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              now={now}
              active={workflowView?.kind === 'workflow' && workflowView.id === workflow.id}
              datasources={datasources}
              onOpen={() => openWorkflow(workflow.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

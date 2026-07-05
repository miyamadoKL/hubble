/**
 * ワークフローステップの編集モーダル。
 * 名前、SQL 文、実行先 datasource (省略時はワークフロー既定)、catalog/schema、
 * 失敗時ポリシー (stop / continue) を編集する。編集結果はローカルドラフトへ
 * 反映されるだけで、サーバー保存はワークフロービュー側の Save が行う。
 */
import { useState } from 'react';
import type { DatasourceSummary, WorkflowStep } from '@hubble/contracts';
import { Trash2 } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { cn } from '../../utils/cn';

const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

/**
 * ステップ編集モーダルを描画する。
 * @param open モーダルの表示状態。
 * @param step 編集対象のステップ。新規追加時は blankStep() で生成した空ステップを渡す。
 * @param isNew 新規追加かどうか (タイトルと削除ボタンの表示に影響)。
 * @param datasources 実行先セレクトに表示するデータソース一覧。
 * @param defaultDatasourceLabel ワークフロー既定 datasource の表示名 (継承オプションのラベル用)。
 * @param onApply 編集を確定してドラフトへ反映するコールバック。
 * @param onDelete ステップを削除するコールバック (新規追加時は非表示)。
 * @param onClose 変更を破棄して閉じるコールバック。
 */
export function StepEditorModal({
  open,
  step,
  isNew,
  datasources,
  defaultDatasourceLabel,
  onApply,
  onDelete,
  onClose,
}: {
  open: boolean;
  step: WorkflowStep | null;
  isNew: boolean;
  datasources: DatasourceSummary[];
  defaultDatasourceLabel: string;
  onApply: (step: WorkflowStep) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  // 閉じている間はアンマウントし、開くたびに Body を step.id キーで再マウントして
  // ローカル入力を初期化する (effect での setState を避ける)。
  if (!open || !step) return null;
  return (
    <StepEditorBody
      key={step.id}
      step={step}
      isNew={isNew}
      datasources={datasources}
      defaultDatasourceLabel={defaultDatasourceLabel}
      onApply={onApply}
      onDelete={onDelete}
      onClose={onClose}
    />
  );
}

/** ステップ編集モーダルの本体。マウント時に step からローカル入力を初期化する。 */
function StepEditorBody({
  step,
  isNew,
  datasources,
  defaultDatasourceLabel,
  onApply,
  onDelete,
  onClose,
}: {
  step: WorkflowStep;
  isNew: boolean;
  datasources: DatasourceSummary[];
  defaultDatasourceLabel: string;
  onApply: (step: WorkflowStep) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowStep>({ ...step });

  const canApply = draft.name.trim() !== '' && draft.statement.trim() !== '';

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'Add step' : 'Edit step'}
      className="max-w-2xl"
      footer={
        <>
          {/* 既存ステップのみ削除を出す。左端に置き、確定系ボタンと離す。 */}
          {!isNew && onDelete && (
            <Button
              variant="ghost"
              icon={Trash2}
              onClick={onDelete}
              className="mr-auto text-ink-subtle hover:text-error"
            >
              Remove step
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onApply(draft)} disabled={!canApply}>
            {isNew ? 'Add step' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Name</span>
          <input
            autoFocus
            value={draft.name}
            aria-label="Step name"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Build daily aggregate"
            className={TEXT_INPUT}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>SQL statement</span>
          <textarea
            value={draft.statement}
            aria-label="Step SQL statement"
            onChange={(e) => setDraft({ ...draft, statement: e.target.value })}
            placeholder="SELECT …"
            rows={10}
            spellCheck={false}
            className={cn(TEXT_INPUT, 'resize-y font-mono text-xs leading-relaxed')}
          />
        </label>

        {/* 実行先と失敗時ポリシー。1 行に収めて操作項目を最小限に見せる。 */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Datasource</span>
            <select
              value={draft.datasourceId ?? ''}
              aria-label="Step datasource"
              onChange={(e) => {
                const value = e.target.value;
                const next = { ...draft };
                if (value === '') delete next.datasourceId;
                else next.datasourceId = value;
                setDraft(next);
              }}
              className={cn(TEXT_INPUT, 'py-1.5')}
            >
              <option value="">Workflow default ({defaultDatasourceLabel})</option>
              {datasources.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.displayName || ds.id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>If this step fails</span>
            <select
              value={draft.onFailure}
              aria-label="On failure policy"
              onChange={(e) =>
                setDraft({ ...draft, onFailure: e.target.value as WorkflowStep['onFailure'] })
              }
              className={cn(TEXT_INPUT, 'py-1.5')}
            >
              <option value="stop">Stop the workflow</option>
              <option value="continue">Continue to the next stage</option>
            </select>
          </label>
        </div>

        {/* catalog/schema の上書き (任意)。 */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Catalog (optional)</span>
            <input
              value={draft.catalog ?? ''}
              aria-label="Step catalog"
              onChange={(e) => {
                const value = e.target.value;
                const next = { ...draft };
                if (value === '') delete next.catalog;
                else next.catalog = value;
                setDraft(next);
              }}
              className={TEXT_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Schema (optional)</span>
            <input
              value={draft.schema ?? ''}
              aria-label="Step schema"
              onChange={(e) => {
                const value = e.target.value;
                const next = { ...draft };
                if (value === '') delete next.schema;
                else next.schema = value;
                setDraft(next);
              }}
              className={TEXT_INPUT}
            />
          </label>
        </div>
      </div>
    </Modal>
  );
}

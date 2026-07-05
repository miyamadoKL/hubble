/**
 * ワークフローの実行設定モーダル。
 * 既定 datasource、cron スケジュール (有効/無効と cron 式)、説明文を編集する。
 * 変更はローカルドラフトへ反映されるだけで、サーバー保存はビュー側の Save が行う。
 */
import { useState } from 'react';
import type { DatasourceSummary } from '@hubble/contracts';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { cn } from '../../utils/cn';
import type { WorkflowDraft } from './workflowFormat';

const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

// 5 フィールドの cron 式かどうかの簡易チェック (厳密な意味解析はサーバー側)。
const CRON_FIELD = String.raw`[0-9A-Za-z*/,\-?]+`;
const CRON_RE = new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4}$`);

/** モーダルで編集する設定値のサブセット。 */
export interface WorkflowSettings {
  description: string;
  datasourceId: string;
  cron: string | null;
  enabled: boolean;
}

/**
 * ワークフロー設定モーダルを描画する。
 * @param open モーダルの表示状態。
 * @param draft 現在のワークフロードラフト (初期値として使う)。
 * @param datasources 既定 datasource セレクトに表示するデータソース一覧。
 * @param onApply 設定を確定してドラフトへ反映するコールバック。
 * @param onClose 変更を破棄して閉じるコールバック。
 */
export function WorkflowSettingsModal({
  open,
  draft,
  datasources,
  onApply,
  onClose,
}: {
  open: boolean;
  draft: WorkflowDraft;
  datasources: DatasourceSummary[];
  onApply: (settings: WorkflowSettings) => void;
  onClose: () => void;
}) {
  // 閉じている間はアンマウントし、開くたびに Body を再マウントして
  // ドラフトの現在値で初期化する (effect での setState を避ける)。
  if (!open) return null;
  return (
    <WorkflowSettingsBody
      draft={draft}
      datasources={datasources}
      onApply={onApply}
      onClose={onClose}
    />
  );
}

/** 設定モーダルの本体。マウント時にドラフトからローカル入力を初期化する。 */
function WorkflowSettingsBody({
  draft,
  datasources,
  onApply,
  onClose,
}: {
  draft: WorkflowDraft;
  datasources: DatasourceSummary[];
  onApply: (settings: WorkflowSettings) => void;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(draft.description);
  const [datasourceId, setDatasourceId] = useState(draft.datasourceId);
  // cron 入力欄の生文字列。空文字は「スケジュールなし (手動のみ)」を表す。
  const [cronText, setCronText] = useState(draft.cron ?? '');
  const [enabled, setEnabled] = useState(draft.enabled);

  const cronTrimmed = cronText.trim();
  const cronValid = cronTrimmed === '' || CRON_RE.test(cronTrimmed);

  return (
    <Modal
      open
      onClose={onClose}
      title="Workflow settings"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!cronValid}
            onClick={() =>
              onApply({
                description,
                datasourceId,
                cron: cronTrimmed === '' ? null : cronTrimmed,
                enabled,
              })
            }
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Description</span>
          <input
            value={description}
            aria-label="Workflow description"
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this workflow produce?"
            className={TEXT_INPUT}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Default datasource</span>
          <select
            value={datasourceId}
            aria-label="Default datasource"
            onChange={(e) => setDatasourceId(e.target.value)}
            className={cn(TEXT_INPUT, 'py-1.5')}
          >
            {datasources.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.displayName || ds.id}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Schedule (cron, optional)</span>
          <input
            value={cronText}
            aria-label="Cron expression"
            onChange={(e) => setCronText(e.target.value)}
            placeholder="e.g. 0 7 * * 1-5 (leave empty for manual only)"
            className={cn(TEXT_INPUT, 'font-mono text-xs', !cronValid && 'border-error')}
          />
          {!cronValid && (
            <span className="text-2xs text-error">
              Must be a 5-field cron expression (minute hour day month weekday).
            </span>
          )}
        </label>

        {/* cron が設定されているときだけ有効/無効トグルを見せる (操作項目を最小限に)。 */}
        {cronTrimmed !== '' && (
          <label className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={enabled ? 'Disable schedule' : 'Enable schedule'}
              onClick={() => setEnabled((v) => !v)}
              className={cn(
                'flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
                enabled ? 'bg-accent' : 'bg-surface-inset',
              )}
            >
              <span
                className={cn(
                  'h-3 w-3 rounded-full bg-surface-base transition-transform',
                  enabled && 'translate-x-3',
                )}
              />
            </button>
            <span className="text-sm text-ink-base">Schedule enabled</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

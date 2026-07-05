/**
 * Alert 作成と編集のモーダル。
 */
import { useState } from 'react';
import type { Alert, CreateAlertRequest, SavedQuery, UpdateAlertRequest } from '@hubble/contracts';
import {
  alertOpSchema,
  alertSelectorSchema,
  cronExpression,
  defaultAlertNotifications,
} from '@hubble/contracts';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { CRON_PRESETS } from './scheduleFormat';
import { cn } from '../../utils/cn';

const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

const OPS = alertOpSchema.options;
const SELECTORS = alertSelectorSchema.options;

interface AlertFormModalProps {
  open: boolean;
  alert?: Alert | null;
  savedQueries: SavedQuery[];
  submitting: boolean;
  onClose: () => void;
  onCreate: (body: CreateAlertRequest) => void;
  onUpdate: (body: UpdateAlertRequest) => void;
}

function parseEmailRecipients(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function alertToRequest(alert: Alert): UpdateAlertRequest {
  return {
    name: alert.name,
    savedQueryId: alert.savedQueryId,
    columnName: alert.columnName,
    op: alert.op,
    value: alert.value,
    selector: alert.selector,
    rearm: alert.rearm,
    muted: alert.muted,
    cron: alert.cron,
    notifications: alert.notifications,
  };
}

/** Alert 作成/編集フォームモーダル。 */
export function AlertFormModal({
  open,
  alert,
  savedQueries,
  submitting,
  onClose,
  onCreate,
  onUpdate,
}: AlertFormModalProps) {
  const editing = Boolean(alert);

  const [name, setName] = useState(alert?.name ?? '');
  const [savedQueryId, setSavedQueryId] = useState(
    alert?.savedQueryId ?? savedQueries[0]?.id ?? '',
  );
  const [columnName, setColumnName] = useState(alert?.columnName ?? '');
  const [op, setOp] = useState(alert?.op ?? OPS[0]!);
  const [value, setValue] = useState(alert?.value ?? '');
  const [selector, setSelector] = useState(alert?.selector ?? 'first');
  const [rearm, setRearm] = useState(String(alert?.rearm ?? 0));
  const [muted, setMuted] = useState(alert?.muted ?? false);
  const [cron, setCron] = useState(alert?.cron ?? CRON_PRESETS[2]!.cron);
  const initialNotifications = alert?.notifications ?? defaultAlertNotifications;
  const [notifySlack, setNotifySlack] = useState(initialNotifications.channels.includes('slack'));
  const [notifyEmail, setNotifyEmail] = useState(initialNotifications.channels.includes('email'));
  const [notifyWebhook, setNotifyWebhook] = useState(
    initialNotifications.channels.includes('webhook'),
  );
  const [notifyEmailTo, setNotifyEmailTo] = useState(
    initialNotifications.emailTo?.join(', ') ?? '',
  );
  const [webhookUrl, setWebhookUrl] = useState(initialNotifications.webhookUrl ?? '');

  if (!open) return null;

  const cronValid = cronExpression.safeParse(cron).success;
  const nameValid = name.trim().length > 0;
  const savedQueryValid = savedQueryId.length > 0;
  const columnValid = columnName.trim().length > 0;
  const rearmNum = Number(rearm);
  const rearmValid = Number.isInteger(rearmNum) && rearmNum >= 0;
  const emailRecipients = parseEmailRecipients(notifyEmailTo);
  const notificationValid =
    (!notifyEmail || emailRecipients.length > 0) && (!notifyWebhook || webhookUrl.trim() !== '');
  const canSave =
    nameValid &&
    savedQueryValid &&
    columnValid &&
    cronValid &&
    rearmValid &&
    notificationValid &&
    !submitting;

  const buildBody = (): CreateAlertRequest => ({
    name: name.trim(),
    savedQueryId,
    columnName: columnName.trim(),
    op,
    value,
    selector,
    rearm: rearmNum,
    muted,
    cron,
    notifications: {
      channels: [
        ...(notifySlack ? (['slack'] as const) : []),
        ...(notifyEmail ? (['email'] as const) : []),
        ...(notifyWebhook ? (['webhook'] as const) : []),
      ],
      ...(notifyEmail ? { emailTo: emailRecipients } : {}),
      ...(notifyWebhook ? { webhookUrl: webhookUrl.trim() } : {}),
    },
  });

  const submit = () => {
    if (!canSave) return;
    const body = buildBody();
    if (editing) onUpdate(body);
    else onCreate(body);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit alert' : 'New alert'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={submit}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Name</span>
          <input className={TEXT_INPUT} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Saved query</span>
          <select
            className={TEXT_INPUT}
            value={savedQueryId}
            onChange={(e) => setSavedQueryId(e.target.value)}
          >
            {savedQueries.map((sq) => (
              <option key={sq.id} value={sq.id}>
                {sq.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Column</span>
            <input
              className={TEXT_INPUT}
              value={columnName}
              onChange={(e) => setColumnName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Operator</span>
            <select
              className={TEXT_INPUT}
              value={op}
              onChange={(e) => setOp(e.target.value as typeof op)}
            >
              {OPS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Threshold</span>
            <input
              className={TEXT_INPUT}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Selector</span>
            <select
              className={TEXT_INPUT}
              value={selector}
              onChange={(e) => setSelector(e.target.value as typeof selector)}
            >
              {SELECTORS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Rearm (seconds)</span>
            <input
              className={TEXT_INPUT}
              type="number"
              min={0}
              value={rearm}
              onChange={(e) => setRearm(e.target.value)}
            />
          </label>
        </div>

        {/* Cron: ScheduleFormModal と同じプリセットチップ + 妥当性フィードバック。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Schedule (cron)</span>
          <div className="flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((preset) => (
              <button
                key={preset.cron}
                type="button"
                aria-pressed={cron === preset.cron}
                onClick={() => setCron(preset.cron)}
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-2xs font-medium transition-colors',
                  cron === preset.cron
                    ? 'bg-accent-soft text-accent'
                    : 'bg-surface-sunken text-ink-muted hover:text-ink-strong',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <input
            value={cron}
            aria-label="Cron expression"
            spellCheck={false}
            onChange={(e) => setCron(e.target.value)}
            placeholder="minute hour day-of-month month day-of-week"
            className={cn(TEXT_INPUT, 'font-mono', !cronValid && 'border-error focus:border-error')}
          />
          {/* cron 式が 5 フィールド形式として妥当かどうかでエラー文言と補足説明を切り替える。 */}
          {!cronValid ? (
            <p role="alert" className="font-mono text-2xs text-error">
              Must be a 5-field cron expression (minute hour day-of-month month day-of-week).
            </p>
          ) : (
            <p className="font-mono text-2xs text-ink-subtle">
              Next evaluation time is computed by the server and shown in the list after saving.
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-strong">
          <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} />
          Muted (no notifications)
        </label>

        <fieldset className="flex flex-col gap-2 rounded-md border border-border-base p-3">
          <legend className={cn(FIELD_LABEL, 'px-1')}>Notifications</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notifySlack}
              onChange={(e) => setNotifySlack(e.target.checked)}
            />
            Slack (server webhook)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.checked)}
            />
            Email
          </label>
          {notifyEmail && (
            <input
              className={TEXT_INPUT}
              placeholder="ops@example.com"
              value={notifyEmailTo}
              onChange={(e) => setNotifyEmailTo(e.target.value)}
            />
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notifyWebhook}
              onChange={(e) => setNotifyWebhook(e.target.checked)}
            />
            Webhook
          </label>
          {notifyWebhook && (
            <input
              className={TEXT_INPUT}
              placeholder="https://example.com/hook"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          )}
        </fieldset>
      </div>
    </Modal>
  );
}

export { alertToRequest };

/**
 * Alert 作成と編集のモーダル。
 */
import { useState } from 'react';
import type { Alert, CreateAlertRequest, SavedQuery, UpdateAlertRequest } from '@hubble/contracts';
import { alertOpSchema, alertSelectorSchema, defaultAlertNotifications } from '@hubble/contracts';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { ScheduleBuilder } from './ScheduleBuilder';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { useLocale } from '../../i18n/locale';
import { commonMessages } from '../../i18n/messages/common';
import { alertMessages } from '../../i18n/messages/alert';
import { alertSelectorLabel } from './alertFormat';

/** AlertFormModal 内で使う辞書の合成。共通文言 + Alert 固有文言を 1 つの t() で引けるようにする。 */
const alertFormDict = { ...commonMessages, ...alertMessages } as const;

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
export function AlertFormModal({ open, ...props }: AlertFormModalProps) {
  if (!open) return null;
  const targetKey = props.alert?.id ?? 'new';
  return <AlertFormModalBody key={targetKey} {...props} />;
}

/** 開くたびにマウントし直す、Alert フォームの状態保持部分。 */
function AlertFormModalBody({
  alert,
  savedQueries,
  submitting,
  onClose,
  onCreate,
  onUpdate,
}: Omit<AlertFormModalProps, 'open'>) {
  const t = useT(alertFormDict);
  const { locale } = useLocale();
  const editing = Boolean(alert);

  // React Hook Form への置換は見送っている。2026 年 7 月 16 日の PoC で本コンポーネントの
  // 14 個の useState と手書き validity を移行したところ、現行 UI は webhook URL の形式を
  // 検証せず（下記 notificationValid は空文字チェックのみ）サーバーの request schema より
  // 弱い validation 契約になっているため、この差を保つ form schema と payload 変換、
  // 初期 isValid を合わせる useEffect(trigger) が必要になった。結果として本ファイルは
  // 333 行から 339 行へ増え、production 60 行削減の採用基準を満たさなかったため、
  // 依存と実装差分を撤去し useState ベースの現行実装を維持している。
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
  const [cron, setCron] = useState(alert?.cron ?? '0 9 * * *');
  const [cronValid, setCronValid] = useState(true);
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
      open
      onClose={onClose}
      title={editing ? t('editAlert') : t('newAlertTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={submit}>
            {submitting ? t('savingButton') : t('saveButton')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t('nameLabel')}</span>
          <input className={TEXT_INPUT} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t('savedQueryLabel')}</span>
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
            <span className={FIELD_LABEL}>{t('columnLabel')}</span>
            <input
              className={TEXT_INPUT}
              value={columnName}
              onChange={(e) => setColumnName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            {/* op は契約層の演算子記号（>, <, = 等）そのものなので翻訳しない。 */}
            <span className={FIELD_LABEL}>{t('operatorLabel')}</span>
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
            <span className={FIELD_LABEL}>{t('thresholdLabel')}</span>
            <input
              className={TEXT_INPUT}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>{t('selectorLabel')}</span>
            <select
              className={TEXT_INPUT}
              value={selector}
              onChange={(e) => setSelector(e.target.value as typeof selector)}
            >
              {/* option の value は契約値（first/max/min）をそのまま送信し、
                  表示ラベルだけ翻訳する（レビュー指摘）。 */}
              {SELECTORS.map((item) => (
                <option key={item} value={item}>
                  {alertSelectorLabel(item, locale)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>{t('rearmSecondsLabel')}</span>
            <input
              className={TEXT_INPUT}
              type="number"
              min={0}
              value={rearm}
              onChange={(e) => setRearm(e.target.value)}
            />
          </label>
        </div>

        {/* Schedule: 毎時/毎日/毎週/毎月のプリセット、または上級者向けの cron 直接入力。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>{t('scheduleLabel')}</span>
          <ScheduleBuilder value={cron} onChange={setCron} onValidChange={setCronValid} />
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-strong">
          <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} />
          {t('mutedCheckbox')}
        </label>

        <fieldset className="flex flex-col gap-2 rounded-md border border-border-base p-3">
          <legend className={cn(FIELD_LABEL, 'px-1')}>{t('notificationsLegend')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notifySlack}
              onChange={(e) => setNotifySlack(e.target.checked)}
            />
            {t('slackServerWebhook')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.checked)}
            />
            {t('emailLabel')}
          </label>
          {notifyEmail && (
            <input
              className={TEXT_INPUT}
              placeholder={t('emailPlaceholder')}
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
            {t('webhookLabel')}
          </label>
          {notifyWebhook && (
            <input
              className={TEXT_INPUT}
              placeholder={t('webhookPlaceholder')}
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

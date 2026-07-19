/**
 * スケジュール作成と編集のモーダル（クエリスケジューラー機能）。
 *
 * アシストサイドバーの SchedulesPanel から「New schedule」ボタン、または各行の
 * 「Edit」ボタンを押したときに開くフォームダイアログ。名前、参照する保存済みクエリ、
 * cron 式、有効フラグ、リトライポリシー、失敗通知を入力させ、保存時に呼び出し元
 * （SchedulesPanel）へ CreateScheduleRequest / UpdateScheduleRequest を渡す。
 * SQL 文と実行先（datasource/catalog/schema）は常に選択した保存済みクエリが持つ値を
 * 使うため（schedule 側では二重管理しない）、このフォームでは編集できない
 * 読み取り専用プレビューとしてのみ表示する。送信後にサーバーから VALIDATION_ERROR
 * （Trino のエラーメッセージ + 行/列）が返った場合は serverError として画面下部に表示する。
 */
import { useMemo, useState } from 'react';
import type {
  DatasourceSummary,
  SavedQuery,
  Schedule,
  CreateScheduleRequest,
  UpdateScheduleRequest,
} from '@hubble/contracts';
import { defaultRetryPolicy, defaultScheduleNotifications } from '@hubble/contracts';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { clampRetryField, RETRY_BOUNDS, type FormError } from './scheduleFormat';
import { ScheduleBuilder } from './ScheduleBuilder';
import { cn } from '../../utils/cn';
import { resolveDatasourceLabel } from '../../hooks/useDatasources';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { scheduleMessages } from '../../i18n/messages/schedule';

/** ScheduleFormModal 内で使う辞書の合成。共通文言 + Schedule 固有文言を 1 つの t() で引けるようにする。 */
const scheduleFormDict = { ...commonMessages, ...scheduleMessages } as const;

interface ScheduleFormModalProps {
  /** モーダルの開閉状態。false の間は何も描画しない（後述の early return）。 */
  open: boolean;
  /** Existing schedule when editing; null/undefined for create. */
  // 編集対象の既存スケジュール。未指定や null のときは新規作成モードとして扱う。
  schedule?: Schedule | null;
  /** 接続先表示用のデータソース一覧（プレビューの接続先バッジに使う）。 */
  datasources: DatasourceSummary[];
  /** 保存済みクエリ一覧（ピッカーと SQL プレビュー表示用）。 */
  savedQueries: SavedQuery[];
  /** 作成と更新のミューテーションが実行中かどうか。true の間は保存ボタンを無効化する。 */
  submitting: boolean;
  /** Server error from the last submit (null while clean). */
  // 直前の送信で返ってきたサーバー側バリデーションエラー（未送信や成功時は null）。
  serverError: FormError | null;
  /** モーダルを閉じる（キャンセル操作、または保存成功時に呼び出し元から呼ばれる）。 */
  onClose: () => void;
  /** 新規作成を確定する（新規作成モードで保存したときに呼ばれる）。 */
  onCreate: (body: CreateScheduleRequest) => void;
  /** 既存スケジュールの更新を確定する（編集モードで保存したときに呼ばれる）。 */
  onUpdate: (body: UpdateScheduleRequest) => void;
}

// フォーム内のラベル / テキスト入力で共通利用する Tailwind クラス文字列。
const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

function parseEmailRecipients(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * スケジュールの作成と編集のモーダル本体。
 * `schedule` prop の有無で編集モードか新規作成モードかを判定し（`editing`）、
 * 各フィールドをローカル state として保持する。保存ボタンは名前必須、保存済みクエリ選択必須、
 * cron 式有効、送信中でない、をすべて満たしたときだけ活性化する。
 */
export function ScheduleFormModal({ open, ...props }: ScheduleFormModalProps) {
  // Reset the form to the target schedule's values each time the modal opens.
  // Rendering nothing while closed means a fresh mount restores these defaults.
  // 閉じている間は状態保持部分を描画しないため、次に開くと対象scheduleの初期値で
  // 新しくマウントされる。開いたまま対象が変わる場合もkeyで同じ再初期化を行う。
  if (!open) return null;
  const targetKey = props.schedule?.id ?? 'new';
  return <ScheduleFormModalBody key={targetKey} {...props} />;
}

/** 開くたびにマウントし直す、Schedule フォームの状態保持部分。 */
function ScheduleFormModalBody({
  schedule,
  datasources,
  savedQueries,
  submitting,
  serverError,
  onClose,
  onCreate,
  onUpdate,
}: Omit<ScheduleFormModalProps, 'open'>) {
  const t = useT(scheduleFormDict);
  const editing = Boolean(schedule);

  const [name, setName] = useState(schedule?.name ?? '');
  const [savedQueryId, setSavedQueryId] = useState(
    schedule?.savedQueryId ?? savedQueries[0]?.id ?? '',
  );
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * *');
  const [cronValid, setCronValid] = useState(true);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [retry, setRetry] = useState(schedule?.retry ?? defaultRetryPolicy);
  const initialNotifications = schedule?.notifications ?? defaultScheduleNotifications;
  const [notifyOnFailure, setNotifyOnFailure] = useState(initialNotifications.onFailure);
  const [notifySlack, setNotifySlack] = useState(initialNotifications.channels.includes('slack'));
  const [notifyEmail, setNotifyEmail] = useState(initialNotifications.channels.includes('email'));
  const [notifyEmailTo, setNotifyEmailTo] = useState(
    initialNotifications.emailTo?.join(', ') ?? '',
  );

  // saved query 一覧はモーダルを開いた後に非同期で届く（SchedulesPanel 側のクエリが
  // 完了する前にモーダルを開くと、初回マウント時点では savedQueries が空配列）。
  // 未選択のまま一覧が届いた場合、先頭候補へ復旧させる（プルダウンが「候補ゼロ」の
  // まま固まって見える問題への対応）。React が推奨する「レンダー中に state を調整する」
  // パターン (useEffect は使わない): props である savedQueries の参照が変わった回の
  // レンダー中にだけ判定し、前回の参照を state に保存しておくことで多重発火を防ぐ。
  const [syncedSavedQueries, setSyncedSavedQueries] = useState(savedQueries);
  if (savedQueries !== syncedSavedQueries) {
    setSyncedSavedQueries(savedQueries);
    if (!savedQueryId) {
      const first = savedQueries[0];
      if (first) setSavedQueryId(first.id);
    }
  }

  const selectedSavedQuery = savedQueries.find((q) => q.id === savedQueryId);
  const connectionLabel = selectedSavedQuery?.datasourceId
    ? resolveDatasourceLabel(datasources, selectedSavedQuery.datasourceId)
    : undefined;

  // フォームのバリデーション: 保存済みクエリの選択必須、cron 式の妥当性、名前の
  // 必須チェックをまとめて評価する。いずれかが不成立、または送信中であれば保存不可。
  const nameValid = name.trim().length > 0;
  const savedQueryValid = savedQueryId.length > 0;
  const emailRecipients = parseEmailRecipients(notifyEmailTo);
  const notificationValid = !notifyOnFailure || !notifyEmail || emailRecipients.length > 0;
  const canSave = nameValid && savedQueryValid && cronValid && notificationValid && !submitting;

  // リトライ設定の数値入力（文字列）をコントラクト定義の範囲にクランプしてから state に反映する。
  const setRetryField = (field: keyof typeof RETRY_BOUNDS, raw: string) => {
    const next = clampRetryField(field, Number(raw));
    setRetry((r) => ({ ...r, [field]: next }));
  };

  // 保存ボタン押下時のハンドラー。編集モードなら UpdateScheduleRequest、新規作成モードなら
  // CreateScheduleRequest を組み立てて呼び出し元へ渡す。
  const submit = () => {
    if (!canSave) return;
    const notifications = {
      onFailure: notifyOnFailure,
      channels: [
        ...(notifySlack ? (['slack'] as const) : []),
        ...(notifyEmail ? (['email'] as const) : []),
      ],
      ...(emailRecipients.length > 0 ? { emailTo: emailRecipients } : {}),
    };
    if (editing && schedule) {
      const body: UpdateScheduleRequest = {
        name: name.trim(),
        savedQueryId,
        cron,
        enabled,
        retry,
        notifications,
      };
      onUpdate(body);
    } else {
      const body: CreateScheduleRequest = {
        name: name.trim(),
        savedQueryId,
        cron,
        enabled,
        retry,
        notifications,
      };
      onCreate(body);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? t('editSchedule') : t('newScheduleTitle')}
      description={t('formDescription')}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSave}>
            {editing ? t('saveChanges') : t('createSchedule')}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-auto pr-1">
        {/* Name */}
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>{t('nameLabel')}</span>
          <input
            autoFocus
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            className={TEXT_INPUT}
          />
        </label>

        {/* 保存済みクエリのピッカー。SQL 直書きは廃止済みで、schedule は必ず
            savedQueryId を参照する。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>{t('queryLabel')}</span>
          {savedQueries.length > 0 ? (
            <select
              className={TEXT_INPUT}
              aria-label={t('savedQueryOption')}
              value={savedQueryId}
              onChange={(e) => setSavedQueryId(e.target.value)}
            >
              {savedQueries.map((sq) => (
                <option key={sq.id} value={sq.id}>
                  {sq.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="font-mono text-2xs text-ink-subtle">{t('noSavedQueriesYet')}</p>
          )}
        </div>

        {/* 選択中クエリの読み取り専用プレビュー（SaveQueryModal と同じ流儀）。
            接続先と SQL 文は選択したクエリが持つ値であり、ここでは編集できない。 */}
        {selectedSavedQuery && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>{t('connectionLabel')}</span>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-2xs text-ink-muted">
                <span className="rounded-full bg-surface-sunken px-2 py-0.5">
                  {connectionLabel ?? t('serverDefaultLabel')}
                </span>
                {selectedSavedQuery.catalog && (
                  <span className="rounded-full bg-surface-sunken px-2 py-0.5">
                    {selectedSavedQuery.catalog}
                    {selectedSavedQuery.schema ? `.${selectedSavedQuery.schema}` : ''}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>{t('sqlPreviewLabel')}</span>
              <pre className="max-h-32 overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap text-ink-base">
                {selectedSavedQuery.statement}
              </pre>
            </div>
          </>
        )}

        {/* Schedule: 毎時/毎日/毎週/毎月のプリセット、または上級者向けの cron 直接入力
            （ユーザー指摘 1: cron 生入力は非エンジニアに使えない）。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>{t('scheduleLabel')}</span>
          <ScheduleBuilder value={cron} onChange={setCron} onValidChange={setCronValid} />
        </div>

        {/* Retry */}
        <fieldset className="flex flex-col gap-2">
          <legend className={FIELD_LABEL}>{t('retryPolicyLegend')}</legend>
          <div className="grid grid-cols-3 gap-3">
            <RetryNumber
              label={t('maxAttemptsLabel')}
              field="maxAttempts"
              value={retry.maxAttempts}
              onChange={setRetryField}
            />
            <RetryNumber
              label={t('backoffSecondsLabel')}
              field="backoffSeconds"
              value={retry.backoffSeconds}
              onChange={setRetryField}
            />
            <RetryNumber
              label={t('multiplierLabel')}
              field="backoffMultiplier"
              value={retry.backoffMultiplier}
              onChange={setRetryField}
            />
          </div>
        </fieldset>

        {/* Notifications */}
        <fieldset className="flex flex-col gap-2 rounded-md border border-border-subtle px-3 py-2.5">
          <legend className={FIELD_LABEL}>{t('failureNotificationsLegend')}</legend>
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={notifyOnFailure}
              onChange={(e) => setNotifyOnFailure(e.target.checked)}
              className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent"
            />
            <span className="text-sm text-ink-base">{t('notifyAfterFinalFailure')}</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2.5 rounded-md bg-surface-sunken px-3 py-2">
              <input
                type="checkbox"
                checked={notifySlack}
                disabled={!notifyOnFailure}
                onChange={(e) => setNotifySlack(e.target.checked)}
                className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent disabled:opacity-50"
              />
              <span className="text-sm text-ink-base">{t('slackLabel')}</span>
            </label>
            <label className="flex items-center gap-2.5 rounded-md bg-surface-sunken px-3 py-2">
              <input
                type="checkbox"
                checked={notifyEmail}
                disabled={!notifyOnFailure}
                onChange={(e) => setNotifyEmail(e.target.checked)}
                className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent disabled:opacity-50"
              />
              <span className="text-sm text-ink-base">{t('emailLabel')}</span>
            </label>
          </div>
          {notifyOnFailure && notifyEmail && (
            <label className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>{t('emailRecipientsLabel')}</span>
              <input
                name="emailRecipients"
                value={notifyEmailTo}
                onChange={(e) => setNotifyEmailTo(e.target.value)}
                placeholder={t('emailRecipientsPlaceholder')}
                className={cn(TEXT_INPUT, !notificationValid && 'border-error focus:border-error')}
              />
              {!notificationValid && (
                <p role="alert" className="font-mono text-2xs text-error">
                  {t('addAtLeastOneRecipient')}
                </p>
              )}
            </label>
          )}
        </fieldset>

        {/* Enabled */}
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            name="enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent"
          />
          <span className="text-sm text-ink-base">
            {t('enabledLabel')}
            <span className="ml-2 text-2xs text-ink-subtle">{t('disabledScheduleHint')}</span>
          </span>
        </label>

        {/* Server validation error (Trino syntax / cron rejected at submit) */}
        {/* serverError が設定されている場合のみエラーブロックを表示する条件分岐。 */}
        {serverError && <ServerErrorBlock error={serverError} />}
      </div>
    </Modal>
  );
}

// リトライポリシーの数値フィールド（最大試行回数、バックオフ秒数、倍率）を描画する
// 小さな内部コンポーネント。RETRY_BOUNDS から min/max を引いて input に反映する。
function RetryNumber({
  label,
  field,
  value,
  onChange,
}: {
  /** 表示ラベル（例: "Max attempts"）。 */
  label: string;
  /** RETRY_BOUNDS のどのフィールドを編集するか。 */
  field: keyof typeof RETRY_BOUNDS;
  /** 現在の値。 */
  value: number;
  /** 値変更時に呼ばれるコールバック（field と生の入力文字列を渡す）。 */
  onChange: (field: keyof typeof RETRY_BOUNDS, raw: string) => void;
}) {
  const { min, max } = RETRY_BOUNDS[field];
  return (
    // 可視の <span>{label}</span> と重複する aria-label は持たせず、label 要素の
    // implicit association に委ねる（レビュー指摘）。
    <label className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        name={field}
        onChange={(e) => onChange(field, e.target.value)}
        className={cn(TEXT_INPUT, 'font-mono')}
      />
    </label>
  );
}

// サーバーから返った VALIDATION_ERROR を表示するブロック。行/列情報があれば併記し、
// Trino の生メッセージ（trinoMessage）があれば折り返し可能な pre で追加表示する。
function ServerErrorBlock({ error }: { error: FormError }) {
  const t = useT(scheduleFormDict);
  // line が無ければ位置情報なし。あれば「{line}行目、{column}列目」形式の文字列を作る。
  const located = useMemo(() => {
    if (error.line == null) return null;
    return error.column != null
      ? t('locatedWithColumn', { line: error.line, column: error.column })
      : t('locatedLineOnly', { line: error.line });
  }, [error.line, error.column, t]);

  return (
    <div
      role="alert"
      className="rounded-md border border-error/40 bg-error-soft px-3 py-2.5 text-error"
    >
      <p className="flex items-start gap-1.5 text-xs font-medium">
        <AlertTriangle size={14} strokeWidth={1.75} className="mt-px shrink-0" />
        <span>
          {error.message}
          {located && <span className="ml-1 font-mono text-2xs">({located})</span>}
        </span>
      </p>
      {error.trinoMessage && (
        <pre className="mt-1.5 max-h-32 overflow-auto font-mono text-2xs whitespace-pre-wrap text-error/90">
          {error.trinoMessage}
        </pre>
      )}
    </div>
  );
}

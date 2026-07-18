/**
 * スケジュール作成と編集のモーダル（クエリスケジューラー機能）。
 *
 * アシストサイドバーの SchedulesPanel から「New schedule」ボタン、または各行の
 * 「Edit」ボタンを押したときに開くフォームダイアログ。名前、SQL 文、catalog / schema、
 * cron 式、有効フラグ、リトライポリシーを入力させ、保存時に呼び出し元（SchedulesPanel）
 * へ CreateScheduleRequest / UpdateScheduleRequest を渡す。SQL 文はブラウザ内蔵の
 * trino-lang パーサーでその場で構文チェックし、サーバーの EXPLAIN (TYPE VALIDATE) を
 * 呼ぶ前にクライアント側で保存ボタンを無効化する「実行前バリデーション」を行う。送信後に
 * サーバーから VALIDATION_ERROR（Trino のエラーメッセージ + 行/列）が返った場合は
 * serverError として画面下部に表示する。
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
import { checkStatement, clampRetryField, RETRY_BOUNDS, type FormError } from './scheduleFormat';
import { ScheduleBuilder } from './ScheduleBuilder';
import { cn } from '../../utils/cn';
import { Dropdown } from '../common/Dropdown';

/** クエリの入力方式。saved は既存の保存済みクエリ参照、direct は SQL 直接入力。 */
type QueryMode = 'saved' | 'direct';

/**
 * Create / edit form for a schedule (Query Scheduling feature). Modeled on the
 * SaveNotebookModal convention but richer: name / statement / catalog·schema /
 * cron / enabled / retry. The statement is checked client-side with the
 * trino-lang parser — a syntax error disables the save button and shows the
 * error inline (the run-prevention UI). Server VALIDATION_ERROR (Trino's
 * message + line/column) is surfaced after submit.
 */

interface ScheduleFormModalProps {
  /** モーダルの開閉状態。false の間は何も描画しない（後述の early return）。 */
  open: boolean;
  /** Existing schedule when editing; null/undefined for create. */
  // 編集対象の既存スケジュール。未指定や null のときは新規作成モードとして扱う。
  schedule?: Schedule | null;
  /** フォーム初期値に使う catalog / schema。ノートブックの現在の実行コンテキスト。 */
  context: { catalog?: string; schema?: string };
  /** データソース一覧（セレクタ表示用）。 */
  datasources: DatasourceSummary[];
  /** 新規作成時の既定データソース id。 */
  defaultDatasourceId?: string;
  /** 保存済みクエリ一覧（saved query 参照モードのピッカー表示用）。 */
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
 * 各フィールドをローカル state として保持する。保存ボタンは名前必須、SQL 構文有効、
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
  context,
  datasources,
  defaultDatasourceId,
  savedQueries,
  submitting,
  serverError,
  onClose,
  onCreate,
  onUpdate,
}: Omit<ScheduleFormModalProps, 'open'>) {
  const editing = Boolean(schedule);

  const [name, setName] = useState(schedule?.name ?? '');
  // クエリの入力方式: saved query 参照が既定（ユーザー指摘 2 の一貫性要件）。
  // 編集時は既存スケジュールの現在のモードを復元する。
  const [queryMode, setQueryMode] = useState<QueryMode>(
    schedule ? (schedule.savedQueryId ? 'saved' : 'direct') : 'saved',
  );
  const initialSavedQueryId = schedule?.savedQueryId ?? savedQueries[0]?.id ?? '';
  const [savedQueryId, setSavedQueryId] = useState(initialSavedQueryId);
  const [statement, setStatement] = useState(schedule?.statement ?? '');
  // 新規作成（schedule 未指定）かつ saved query が選択済みの場合、その保存済みクエリの
  // catalog / schema / datasourceId を初期値の 3 点セットとして使う。編集時は既存
  // schedule の値が authoritative なので、この初期値は使わない（下の各 useState 参照）。
  const initialSavedQuery = !schedule
    ? savedQueries.find((q) => q.id === initialSavedQueryId)
    : undefined;
  const [catalog, setCatalog] = useState(
    schedule?.catalog ?? initialSavedQuery?.catalog ?? context.catalog ?? '',
  );
  const [schema, setSchema] = useState(
    schedule?.schema ?? initialSavedQuery?.schema ?? context.schema ?? '',
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
  const [datasourceId, setDatasourceId] = useState(
    () =>
      schedule?.datasourceId ??
      initialSavedQuery?.datasourceId ??
      defaultDatasourceId ??
      datasources[0]?.id ??
      '',
  );

  // saved query を選び直すたびに、その保存済みクエリの実行コンテキスト
  // （datasourceId、catalog、schema）を 3 点セットで prefill する（schedule 側の
  // 各値は引き続きユーザーが編集できる authoritative な値）。datasourceId は
  // sq 自身が持っていなくても、意味上の既定データソースへ必ず更新する
  // （前に選ばれていた別の saved query の datasourceId が取り残されるのを防ぐ）。
  const applySavedQuery = (sq: SavedQuery) => {
    setSavedQueryId(sq.id);
    setDatasourceId(sq.datasourceId ?? defaultDatasourceId ?? datasources[0]?.id ?? '');
    setCatalog(sq.catalog ?? '');
    setSchema(sq.schema ?? '');
  };
  const selectSavedQuery = (id: string) => {
    const sq = savedQueries.find((q) => q.id === id);
    if (sq) applySavedQuery(sq);
    else setSavedQueryId(id);
  };
  // 未選択のまま saved query 一覧が使える状態になったら、先頭候補へ復旧する
  // （新規に届いた一覧、または後から saved モードへ切り替えた場合の両方で使う）。
  const recoverSavedQuerySelection = () => {
    if (savedQueryId) return;
    const first = savedQueries[0];
    if (first) applySavedQuery(first);
  };

  // saved query 一覧はモーダルを開いた後に非同期で届く（SchedulesPanel 側のクエリが
  // 完了する前にモーダルを開くと、初回マウント時点では savedQueries が空配列）。
  // saved モードで未選択のまま一覧が届いた場合、先頭候補へ復旧させる
  // （プルダウンが「候補ゼロ」のまま固まって見える問題への対応）。direct モードで
  // 一覧が届いた場合はここでは復旧せず、後で saved モードへ切り替えた時点
  // （下の Saved query ボタンの onClick）で復旧する。
  // React が推奨する「レンダー中に state を調整する」パターン (useEffect は使わない):
  // props である savedQueries の参照が変わった回のレンダー中にだけ判定し、
  // 前回の参照を state に保存しておくことで多重発火を防ぐ。
  const [syncedSavedQueries, setSyncedSavedQueries] = useState(savedQueries);
  if (savedQueries !== syncedSavedQueries) {
    setSyncedSavedQueries(savedQueries);
    if (queryMode === 'saved') recoverSavedQuerySelection();
  }

  // フォームのバリデーション: クエリ入力（direct なら SQL 構文チェック、saved なら
  // 選択必須）、cron 式の妥当性、名前の必須チェックをまとめて評価する。
  // いずれかが不成立、または送信中であれば保存不可。
  const check =
    queryMode === 'direct'
      ? checkStatement(statement, catalog || undefined, schema || undefined)
      : { ok: true as const };
  const savedQueryValid = queryMode === 'saved' ? savedQueryId.length > 0 : true;
  const nameValid = name.trim().length > 0;
  const emailRecipients = parseEmailRecipients(notifyEmailTo);
  const notificationValid = !notifyOnFailure || !notifyEmail || emailRecipients.length > 0;
  const canSave =
    nameValid && check.ok && savedQueryValid && cronValid && notificationValid && !submitting;

  // リトライ設定の数値入力（文字列）をコントラクト定義の範囲にクランプしてから state に反映する。
  const setRetryField = (field: keyof typeof RETRY_BOUNDS, raw: string) => {
    const next = clampRetryField(field, Number(raw));
    setRetry((r) => ({ ...r, [field]: next }));
  };

  // 保存ボタン押下時のハンドラー。編集モードなら UpdateScheduleRequest、新規作成モードなら
  // CreateScheduleRequest を組み立てて呼び出し元へ渡す。catalog / schema は空文字なら
  // 未指定として送信する（編集時は null、新規作成時は undefined と、契約の差異に合わせる）。
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
    // クエリ入力は statement / savedQueryId のどちらか一方のみを送る
    // (契約層の refine が両方指定を拒否するため)。
    const queryFields = queryMode === 'saved' ? { savedQueryId } : { statement };
    if (editing && schedule) {
      const body: UpdateScheduleRequest = {
        name: name.trim(),
        ...queryFields,
        catalog: catalog.trim() ? catalog.trim() : null,
        schema: schema.trim() ? schema.trim() : null,
        cron,
        enabled,
        retry,
        notifications,
        datasourceId: datasourceId || undefined,
      };
      onUpdate(body);
    } else {
      const body: CreateScheduleRequest = {
        name: name.trim(),
        ...queryFields,
        catalog: catalog.trim() || undefined,
        schema: schema.trim() || undefined,
        cron,
        enabled,
        retry,
        notifications,
        datasourceId: datasourceId || undefined,
      };
      onCreate(body);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit schedule' : 'New schedule'}
      description="Run a SQL statement on a cron schedule. The statement is validated before it runs."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSave}>
            {editing ? 'Save changes' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-auto pr-1">
        {/* Name */}
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Name</span>
          <input
            autoFocus
            value={name}
            aria-label="Schedule name"
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly nation count"
            className={TEXT_INPUT}
          />
        </label>

        {/* クエリの入力方式。saved query 参照が既定（ユーザー指摘 2: Alert との一貫性）。
            Notebook で編集して保存したクエリをここから呼び出すのが基本の流れで、
            SQL 直接入力は上級者向けの代替手段として残す。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Query</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Query source">
            <button
              type="button"
              role="radio"
              aria-checked={queryMode === 'saved'}
              onClick={() => {
                setQueryMode('saved');
                // direct モードのまま一覧が届いていた場合、切替の時点で復旧する
                // （一覧到着時は queryMode !== 'saved' だったため復旧されていない）。
                recoverSavedQuerySelection();
              }}
              className={cn(
                'rounded-full px-2.5 py-1 text-2xs font-medium transition-colors',
                queryMode === 'saved'
                  ? 'bg-accent-soft text-accent'
                  : 'bg-surface-sunken text-ink-muted hover:text-ink-strong',
              )}
            >
              Saved query
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={queryMode === 'direct'}
              onClick={() => setQueryMode('direct')}
              className={cn(
                'rounded-full px-2.5 py-1 text-2xs font-medium transition-colors',
                queryMode === 'direct'
                  ? 'bg-accent-soft text-accent'
                  : 'bg-surface-sunken text-ink-muted hover:text-ink-strong',
              )}
            >
              Direct SQL
            </button>
          </div>

          {queryMode === 'saved' ? (
            savedQueries.length > 0 ? (
              <select
                className={TEXT_INPUT}
                aria-label="Saved query"
                value={savedQueryId}
                onChange={(e) => selectSavedQuery(e.target.value)}
              >
                {savedQueries.map((sq) => (
                  <option key={sq.id} value={sq.id}>
                    {sq.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="font-mono text-2xs text-ink-subtle">
                No saved queries yet — save one from the notebook, or switch to Direct SQL.
              </p>
            )
          ) : (
            <>
              <textarea
                value={statement}
                aria-label="SQL statement"
                spellCheck={false}
                onChange={(e) => setStatement(e.target.value)}
                placeholder="SELECT count(*) FROM tpch.tiny.nation"
                rows={5}
                className={cn(
                  TEXT_INPUT,
                  'resize-y font-mono text-xs leading-relaxed',
                  !check.ok && check.message && 'border-error focus:border-error',
                )}
              />
              {/* 構文エラーがあればメッセージ（行/列があれば付記）を表示し、なければ
                  「実行前にローカル検証済み」という補足説明を表示する分岐。 */}
              {!check.ok && check.message ? (
                <p role="alert" className="flex items-start gap-1.5 font-mono text-2xs text-error">
                  <AlertTriangle size={13} strokeWidth={1.75} className="mt-px shrink-0" />
                  <span>
                    Syntax error
                    {check.line != null && (
                      <span className="text-ink-subtle">
                        {' '}
                        (line {check.line}
                        {check.column != null ? `, col ${check.column}` : ''})
                      </span>
                    )}
                    : {check.message}
                  </span>
                </p>
              ) : (
                <p className="font-mono text-2xs text-ink-subtle">
                  Checked locally before every run — invalid SQL can't be saved.
                </p>
              )}
            </>
          )}
        </div>

        {/* Data source */}
        {datasources.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Data source</span>
            <Dropdown
              value={datasourceId}
              options={datasources.map((d) => ({
                value: d.id,
                label: d.displayName,
              }))}
              onChange={setDatasourceId}
              ariaLabel="Schedule data source"
            />
          </label>
        )}

        {/* Catalog / schema */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Catalog</span>
            <input
              value={catalog}
              aria-label="Catalog"
              onChange={(e) => setCatalog(e.target.value)}
              placeholder="(none)"
              className={TEXT_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Schema</span>
            <input
              value={schema}
              aria-label="Schema"
              onChange={(e) => setSchema(e.target.value)}
              placeholder="(none)"
              className={TEXT_INPUT}
            />
          </label>
        </div>

        {/* Schedule: 毎時/毎日/毎週/毎月のプリセット、または上級者向けの cron 直接入力
            （ユーザー指摘 1: cron 生入力は非エンジニアに使えない）。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Schedule</span>
          <ScheduleBuilder value={cron} onChange={setCron} onValidChange={setCronValid} />
        </div>

        {/* Retry */}
        <fieldset className="flex flex-col gap-2">
          <legend className={FIELD_LABEL}>Retry policy</legend>
          <div className="grid grid-cols-3 gap-3">
            <RetryNumber
              label="Max attempts"
              field="maxAttempts"
              value={retry.maxAttempts}
              onChange={setRetryField}
            />
            <RetryNumber
              label="Backoff (s)"
              field="backoffSeconds"
              value={retry.backoffSeconds}
              onChange={setRetryField}
            />
            <RetryNumber
              label="Multiplier"
              field="backoffMultiplier"
              value={retry.backoffMultiplier}
              onChange={setRetryField}
            />
          </div>
        </fieldset>

        {/* Notifications */}
        <fieldset className="flex flex-col gap-2 rounded-md border border-border-subtle px-3 py-2.5">
          <legend className={FIELD_LABEL}>Failure notifications</legend>
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={notifyOnFailure}
              aria-label="Notify on failure"
              onChange={(e) => setNotifyOnFailure(e.target.checked)}
              className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent"
            />
            <span className="text-sm text-ink-base">Notify after final failure</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2.5 rounded-md bg-surface-sunken px-3 py-2">
              <input
                type="checkbox"
                checked={notifySlack}
                disabled={!notifyOnFailure}
                aria-label="Slack notification"
                onChange={(e) => setNotifySlack(e.target.checked)}
                className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent disabled:opacity-50"
              />
              <span className="text-sm text-ink-base">Slack</span>
            </label>
            <label className="flex items-center gap-2.5 rounded-md bg-surface-sunken px-3 py-2">
              <input
                type="checkbox"
                checked={notifyEmail}
                disabled={!notifyOnFailure}
                aria-label="Email notification"
                onChange={(e) => setNotifyEmail(e.target.checked)}
                className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent disabled:opacity-50"
              />
              <span className="text-sm text-ink-base">Email</span>
            </label>
          </div>
          {notifyOnFailure && notifyEmail && (
            <label className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Email recipients</span>
              <input
                value={notifyEmailTo}
                aria-label="Email recipients"
                onChange={(e) => setNotifyEmailTo(e.target.value)}
                placeholder="ops@example.com, data@example.com"
                className={cn(TEXT_INPUT, !notificationValid && 'border-error focus:border-error')}
              />
              {!notificationValid && (
                <p role="alert" className="font-mono text-2xs text-error">
                  Add at least one email recipient.
                </p>
              )}
            </label>
          )}
        </fieldset>

        {/* Enabled */}
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={enabled}
            aria-label="Enabled"
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border-base text-accent focus:ring-accent"
          />
          <span className="text-sm text-ink-base">
            Enabled
            <span className="ml-2 text-2xs text-ink-subtle">
              (disabled schedules never fire automatically)
            </span>
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
    <label className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(field, e.target.value)}
        className={cn(TEXT_INPUT, 'font-mono')}
      />
    </label>
  );
}

// サーバーから返った VALIDATION_ERROR を表示するブロック。行/列情報があれば併記し、
// Trino の生メッセージ（trinoMessage）があれば折り返し可能な pre で追加表示する。
function ServerErrorBlock({ error }: { error: FormError }) {
  // line が無ければ位置情報なし。あれば "line X, col Y" 形式の文字列を作る。
  const located = useMemo(() => {
    if (error.line == null) return null;
    return `line ${error.line}${error.column != null ? `, col ${error.column}` : ''}`;
  }, [error.line, error.column]);

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

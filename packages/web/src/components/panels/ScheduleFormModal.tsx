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
  Schedule,
  CreateScheduleRequest,
  UpdateScheduleRequest,
} from '@hubble/contracts';
import { cronExpression, defaultRetryPolicy } from '@hubble/contracts';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import {
  checkStatement,
  CRON_PRESETS,
  clampRetryField,
  RETRY_BOUNDS,
  type FormError,
} from './scheduleFormat';
import { cn } from '../../utils/cn';
import { Dropdown } from '../common/Dropdown';

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

/**
 * スケジュールの作成と編集のモーダル本体。
 * `schedule` prop の有無で編集モードか新規作成モードかを判定し（`editing`）、
 * 各フィールドをローカル state として保持する。保存ボタンは名前必須、SQL 構文有効、
 * cron 式有効、送信中でない、をすべて満たしたときだけ活性化する。
 */
export function ScheduleFormModal({
  open,
  schedule,
  context,
  datasources,
  defaultDatasourceId,
  submitting,
  serverError,
  onClose,
  onCreate,
  onUpdate,
}: ScheduleFormModalProps) {
  const editing = Boolean(schedule);

  const [name, setName] = useState(schedule?.name ?? '');
  const [statement, setStatement] = useState(schedule?.statement ?? '');
  const [catalog, setCatalog] = useState(schedule?.catalog ?? context.catalog ?? '');
  const [schema, setSchema] = useState(schedule?.schema ?? context.schema ?? '');
  const [cron, setCron] = useState(schedule?.cron ?? CRON_PRESETS[2]!.cron);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [retry, setRetry] = useState(schedule?.retry ?? defaultRetryPolicy);
  const [datasourceId, setDatasourceId] = useState(
    schedule?.datasourceId ?? defaultDatasourceId ?? datasources[0]?.id ?? '',
  );

  // Reset the form to the target schedule's values each time the modal opens.
  // Rendering nothing while closed means a fresh mount restores these defaults.
  if (!open) return null;

  // フォームのバリデーション: SQL 文の構文チェック、cron 式の書式チェック、名前の必須
  // チェックをまとめて評価する。いずれかが不成立、または送信中であれば保存不可。
  const check = checkStatement(statement, catalog || undefined, schema || undefined);
  const cronValid = cronExpression.safeParse(cron).success;
  const nameValid = name.trim().length > 0;
  const canSave = nameValid && check.ok && cronValid && !submitting;

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
    if (editing && schedule) {
      const body: UpdateScheduleRequest = {
        name: name.trim(),
        statement,
        catalog: catalog.trim() ? catalog.trim() : null,
        schema: schema.trim() ? schema.trim() : null,
        cron,
        enabled,
        retry,
        datasourceId: datasourceId || undefined,
      };
      onUpdate(body);
    } else {
      const body: CreateScheduleRequest = {
        name: name.trim(),
        statement,
        catalog: catalog.trim() || undefined,
        schema: schema.trim() || undefined,
        cron,
        enabled,
        retry,
        datasourceId: datasourceId || undefined,
      };
      onCreate(body);
    }
  };

  return (
    <Modal
      open={open}
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

        {/* Statement */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Statement</span>
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

        {/* Cron */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Schedule (cron)</span>
          <div className="flex flex-wrap gap-1.5">
            {/* CRON_PRESETS のワンクリック定型文。押すと cron 入力欄の値をそのまま置き換える。 */}
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
          {/* cron 式が 5 フィールド形式として妥当かどうかで、エラー文言と
              補足説明（次回実行時刻はサーバー側で算出）のどちらを出すか切り替える。 */}
          {!cronValid ? (
            <p role="alert" className="font-mono text-2xs text-error">
              Must be a 5-field cron expression (minute hour day-of-month month day-of-week).
            </p>
          ) : (
            <p className="font-mono text-2xs text-ink-subtle">
              Next run time is computed by the server and shown in the list after saving.
            </p>
          )}
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

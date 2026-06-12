import { useMemo, useState } from 'react';
import type { Schedule, CreateScheduleRequest, UpdateScheduleRequest } from '@hubble/contracts';
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

/**
 * Create / edit form for a schedule (Query Scheduling feature). Modeled on the
 * SaveNotebookModal convention but richer: name / statement / catalog·schema /
 * cron / enabled / retry. The statement is checked client-side with the
 * trino-lang parser — a syntax error disables the save button and shows the
 * error inline (the run-prevention UI). Server VALIDATION_ERROR (Trino's
 * message + line/column) is surfaced after submit.
 */

interface ScheduleFormModalProps {
  open: boolean;
  /** Existing schedule when editing; null/undefined for create. */
  schedule?: Schedule | null;
  context: { catalog?: string; schema?: string };
  submitting: boolean;
  /** Server error from the last submit (null while clean). */
  serverError: FormError | null;
  onClose: () => void;
  onCreate: (body: CreateScheduleRequest) => void;
  onUpdate: (body: UpdateScheduleRequest) => void;
}

const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

export function ScheduleFormModal({
  open,
  schedule,
  context,
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

  // Reset the form to the target schedule's values each time the modal opens.
  // Rendering nothing while closed means a fresh mount restores these defaults.
  if (!open) return null;

  const check = checkStatement(statement, catalog || undefined, schema || undefined);
  const cronValid = cronExpression.safeParse(cron).success;
  const nameValid = name.trim().length > 0;
  const canSave = nameValid && check.ok && cronValid && !submitting;

  const setRetryField = (field: keyof typeof RETRY_BOUNDS, raw: string) => {
    const next = clampRetryField(field, Number(raw));
    setRetry((r) => ({ ...r, [field]: next }));
  };

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
        {serverError && <ServerErrorBlock error={serverError} />}
      </div>
    </Modal>
  );
}

function RetryNumber({
  label,
  field,
  value,
  onChange,
}: {
  label: string;
  field: keyof typeof RETRY_BOUNDS;
  value: number;
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

function ServerErrorBlock({ error }: { error: FormError }) {
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

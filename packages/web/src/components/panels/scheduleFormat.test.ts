import { describe, expect, test } from 'vitest';
import type { ScheduleRunSummary } from '@hubble/contracts';
import { cronExpression } from '@hubble/contracts';
import { ApiClientError } from '../../api/client';
import {
  runTone,
  runStatusLabel,
  summarizeLastRun,
  attemptLabel,
  checkStatement,
  formatApiError,
  CRON_PRESETS,
  clampRetryField,
  RETRY_BOUNDS,
} from './scheduleFormat';

function runSummary(over: Partial<ScheduleRunSummary> = {}): ScheduleRunSummary {
  return {
    id: 'run-1',
    status: 'success',
    attempt: 1,
    trinoQueryId: '20260613_000000_00001_abcde',
    errorType: null,
    errorMessage: null,
    rowCount: 25,
    elapsedMs: 1200,
    scheduledFor: '2026-06-13T00:00:00.000Z',
    startedAt: '2026-06-13T00:00:01.000Z',
    finishedAt: '2026-06-13T00:00:02.200Z',
    ...over,
  };
}

describe('status → display mapping', () => {
  test('maps each status to a tone', () => {
    expect(runTone('running')).toBe('running');
    expect(runTone('success')).toBe('success');
    expect(runTone('failed')).toBe('error');
    expect(runTone('blocked')).toBe('warning');
    expect(runTone('aborted')).toBe('neutral');
  });

  test('labels are upper-case status names', () => {
    expect(runStatusLabel('running')).toBe('RUNNING');
    expect(runStatusLabel('blocked')).toBe('BLOCKED');
  });
});

describe('summarizeLastRun (retry visibility)', () => {
  test('plain success reads as a single word', () => {
    expect(summarizeLastRun(runSummary({ status: 'success' }))).toBe('Success');
  });

  test('a failure that exhausted multiple attempts surfaces the count', () => {
    expect(summarizeLastRun(runSummary({ status: 'failed', attempt: 3 }))).toBe(
      'Failed · 3 attempts',
    );
  });

  test('a single-attempt failure omits the count', () => {
    expect(summarizeLastRun(runSummary({ status: 'failed', attempt: 1 }))).toBe('Failed');
  });

  test('a successful first try never shows a count even with attempt > 1', () => {
    // success after a retry: not a failure, so no "N attempts" suffix here.
    expect(summarizeLastRun(runSummary({ status: 'success', attempt: 2 }))).toBe('Success');
  });
});

describe('attemptLabel', () => {
  test('singular vs plural', () => {
    expect(attemptLabel(1)).toBe('1 attempt');
    expect(attemptLabel(3)).toBe('3 attempts');
  });
});

describe('checkStatement (client-side run-prevention)', () => {
  test('accepts a valid statement', () => {
    const result = checkStatement('SELECT count(*) FROM tpch.tiny.nation');
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
  });

  test('rejects a syntactically invalid statement with a located message', () => {
    const result = checkStatement('SELECT FROM WHERE');
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
    expect(result.line).toBeGreaterThanOrEqual(1);
    expect(result.column).toBeGreaterThanOrEqual(1);
  });

  test('empty input is not ok but carries no error message (required, not broken)', () => {
    const result = checkStatement('   ');
    expect(result.ok).toBe(false);
    expect(result.message).toBeUndefined();
  });
});

describe('formatApiError (VALIDATION_ERROR formatting)', () => {
  test('extracts Trino message + line/column from the details payload', () => {
    const error = new ApiClientError(400, {
      code: 'VALIDATION_ERROR',
      message: 'Statement failed validation',
      details: {
        trinoMessage: "line 1:8: mismatched input 'FROM'",
        line: 1,
        column: 8,
      },
    });
    const formatted = formatApiError(error);
    expect(formatted.message).toBe('Statement failed validation');
    expect(formatted.trinoMessage).toBe("line 1:8: mismatched input 'FROM'");
    expect(formatted.line).toBe(1);
    expect(formatted.column).toBe(8);
  });

  test('falls back to top-level line/column when details omits them', () => {
    const error = new ApiClientError(400, {
      code: 'VALIDATION_ERROR',
      message: 'Bad query',
      line: 2,
      column: 5,
    });
    const formatted = formatApiError(error);
    expect(formatted.line).toBe(2);
    expect(formatted.column).toBe(5);
    expect(formatted.trinoMessage).toBeUndefined();
  });

  test('plain Error falls back to its message', () => {
    expect(formatApiError(new Error('network down')).message).toBe('network down');
  });

  test('unknown throwable yields a generic message', () => {
    expect(formatApiError('weird').message).toBe('Request failed');
  });
});

describe('cron presets', () => {
  test('all presets are valid 5-field cron expressions', () => {
    expect(CRON_PRESETS.length).toBeGreaterThanOrEqual(3);
    for (const preset of CRON_PRESETS) {
      expect(cronExpression.safeParse(preset.cron).success).toBe(true);
    }
  });
});

describe('clampRetryField (contract ranges)', () => {
  test('clamps below the minimum', () => {
    expect(clampRetryField('maxAttempts', 0)).toBe(RETRY_BOUNDS.maxAttempts.min);
    expect(clampRetryField('backoffSeconds', -5)).toBe(RETRY_BOUNDS.backoffSeconds.min);
  });

  test('clamps above the maximum', () => {
    expect(clampRetryField('maxAttempts', 99)).toBe(RETRY_BOUNDS.maxAttempts.max);
    expect(clampRetryField('backoffSeconds', 100_000)).toBe(RETRY_BOUNDS.backoffSeconds.max);
    expect(clampRetryField('backoffMultiplier', 50)).toBe(RETRY_BOUNDS.backoffMultiplier.max);
  });

  test('rounds to an integer within range', () => {
    expect(clampRetryField('backoffSeconds', 61.7)).toBe(62);
  });

  test('NaN falls back to the lower bound', () => {
    expect(clampRetryField('maxAttempts', Number.NaN)).toBe(RETRY_BOUNDS.maxAttempts.min);
  });
});

// 非空の実行履歴を ja ロケールで表示したとき、formatRelativeTime（「n 分前」等）と
// attemptLabel が翻訳されることを検証する（レビュー指摘: formatRelativeTime が
// 翻訳漏れのまま英語 "just now"/"3m ago" 等を出し続けていた）。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Schedule, ScheduleRun } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider } from '../../i18n/locale';

const timestamp = '2026-07-12T00:00:00.000Z';

function scheduleRun(over: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    status: 'success',
    attempt: 1,
    trinoQueryId: 'q-1',
    errorType: null,
    errorMessage: null,
    rowCount: 42,
    elapsedMs: 1200,
    scheduledFor: timestamp,
    // 現在時刻から3分前になるよう startedAt を設定する（formatRelativeTime の
    // "3m ago"/「3 分前」を確実に踏ませるため）。
    startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    finishedAt: timestamp,
    ...over,
  };
}

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-1',
    name: 'Nightly rollup',
    savedQueryId: 'sq_1',
    cron: '0 9 * * *',
    enabled: true,
    retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
    notifications: { onFailure: false, channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRun: null,
    ...over,
  };
}

vi.mock('../../hooks/useSchedules', () => ({
  useScheduleRuns: vi.fn(() => ({
    isPending: false,
    isError: false,
    data: [scheduleRun(), scheduleRun({ id: 'run-2', status: 'failed', attempt: 3 })],
  })),
}));

import { ScheduleRunsModal } from './ScheduleRunsModal';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('ScheduleRunsModal: 非空の実行履歴が ja ロケールで翻訳される', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'language', { value: 'ja-JP', configurable: true });
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('formatRelativeTime が「n 分前」に翻訳される（英語 "ago" の生表示が残らない）', () => {
    act(() =>
      root.render(
        <LocaleProvider>
          <ScheduleRunsModal schedule={schedule()} onClose={vi.fn()} />
        </LocaleProvider>,
      ),
    );
    expect(container.textContent).toContain('分前');
    expect(container.textContent).not.toContain('ago');
  });

  test('attemptLabel（リトライ回数表記）が日本語になる', () => {
    act(() =>
      root.render(
        <LocaleProvider>
          <ScheduleRunsModal schedule={schedule()} onClose={vi.fn()} />
        </LocaleProvider>,
      ),
    );
    // run-2 は attempt=3 の失敗 run なので「3 回の試行」が表示される。
    expect(container.textContent).toContain('回の試行');
    expect(container.textContent).not.toContain('attempts');
  });
});

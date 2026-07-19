// SchedulesPanel の一覧行が、生の cron 式ではなく読み下し文（プリセット式）または
// 「カスタムスケジュール」（カスタム式）を表示することを ja/en 双方で検証する
// （UI/UX から cron 式表示を極力排除する方針。scheduleCron.ts の describeCronForList を参照）。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DatasourceSummary, Schedule } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider } from '../../i18n/locale';

vi.mock('../../api/schedules', () => ({
  listSchedules: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  listScheduleRuns: vi.fn(),
}));

vi.mock('../../api/savedQueries', () => ({
  listSavedQueries: vi.fn(),
}));

vi.mock('../../api/datasources', () => ({
  fetchDatasources: vi.fn(),
}));

import { listSchedules } from '../../api/schedules';
import { listSavedQueries } from '../../api/savedQueries';
import { fetchDatasources } from '../../api/datasources';
import { SchedulesPanel } from './SchedulesPanel';

const timestamp = '2026-07-12T00:00:00.000Z';

const datasources: DatasourceSummary[] = [
  {
    id: 'trino-default',
    kind: 'trino',
    displayName: 'Trino (default)',
    capabilities: { costEstimate: true, catalogs: true },
  },
];

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    name: 'Nightly rollup',
    savedQueryId: 'saved-1',
    cron: '0 9 * * *',
    enabled: true,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 },
    notifications: { onFailure: false, channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRun: null,
    ...over,
  };
}

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

function renderPanel(language: string) {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  window.localStorage.clear();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider>
          <SchedulesPanel search="" />
        </LocaleProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

describe('SchedulesPanel: 一覧行に生の cron 式を表示しない', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(listSavedQueries).mockResolvedValue([]);
    vi.mocked(fetchDatasources).mockResolvedValue({ datasources });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  test('ja: プリセット式（0 9 * * *）は読み下し文になり、生の式は出ない', async () => {
    vi.mocked(listSchedules).mockResolvedValue([schedule({ cron: '0 9 * * *' })]);
    ({ container, root } = renderPanel('ja-JP'));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Nightly rollup');
    });
    expect(container.textContent).toContain('毎日 09:00 に実行');
    expect(container.textContent).not.toContain('0 9 * * *');
  });

  test('ja: カスタム式（*/7 2-4 * * *）は「カスタムスケジュール」になり、生の式は出ない', async () => {
    vi.mocked(listSchedules).mockResolvedValue([schedule({ cron: '*/7 2-4 * * *' })]);
    ({ container, root } = renderPanel('ja-JP'));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Nightly rollup');
    });
    expect(container.textContent).toContain('カスタムスケジュール');
    expect(container.textContent).not.toContain('*/7 2-4 * * *');
  });

  test('en: プリセット式（0 9 * * *）は読み下し文になり、生の式は出ない', async () => {
    vi.mocked(listSchedules).mockResolvedValue([schedule({ cron: '0 9 * * *' })]);
    ({ container, root } = renderPanel('en-US'));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Nightly rollup');
    });
    expect(container.textContent).toContain('Daily at 09:00');
    expect(container.textContent).not.toContain('0 9 * * *');
  });

  test('en: カスタム式（*/7 2-4 * * *）は "Custom schedule" になり、生の式は出ない', async () => {
    vi.mocked(listSchedules).mockResolvedValue([schedule({ cron: '*/7 2-4 * * *' })]);
    ({ container, root } = renderPanel('en-US'));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Nightly rollup');
    });
    expect(container.textContent).toContain('Custom schedule');
    expect(container.textContent).not.toContain('*/7 2-4 * * *');
  });
});

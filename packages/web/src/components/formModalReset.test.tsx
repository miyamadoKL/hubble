// 作成と編集で共用するモーダルが、開く対象ごとにフォーム状態を再初期化することを検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Alert, SavedQuery, Schedule } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// ScheduleBuilder が useServerTimeZone（GET /api/config 経由）を呼ぶため、
// このファイルのテストではネットワーク往復を避けるためにモックする。
vi.mock('../hooks/useConfig', () => ({
  useServerTimeZone: vi.fn(() => null),
}));

import { AlertFormModal } from './panels/AlertFormModal';
import { ScheduleFormModal } from './panels/ScheduleFormModal';
import { SaveNotebookModal } from './notebook/SaveNotebookModal';

const timestamp = '2026-07-12T00:00:00.000Z';

const savedQueries: SavedQuery[] = [
  {
    id: 'saved-1',
    name: 'Saved query 1',
    description: '',
    statement: 'SELECT 1',
    catalog: '',
    schema: '',
    isFavorite: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    myPermission: 'owner',
  },
  {
    id: 'saved-2',
    name: 'Saved query 2',
    description: '',
    statement: 'SELECT 2',
    catalog: '',
    schema: '',
    isFavorite: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    myPermission: 'owner',
  },
];

function alert(id: string, name: string): Alert {
  return {
    id,
    name,
    savedQueryId: 'saved-1',
    columnName: 'count',
    op: '>',
    value: '0',
    selector: 'first',
    rearm: 0,
    muted: false,
    cron: '0 * * * *',
    state: 'unknown',
    lastTriggeredAt: null,
    notifications: { channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextEvalAt: null,
  };
}

function schedule(id: string, name: string, savedQueryId: string): Schedule {
  return {
    id,
    name,
    savedQueryId,
    cron: '0 * * * *',
    enabled: true,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 },
    notifications: { onFailure: false, channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRun: null,
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

describe('フォームモーダルの再初期化', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('Alertの編集対象を切り替えると新しい対象の値を表示する', () => {
    const onUpdate = vi.fn();
    const common = {
      savedQueries,
      submitting: false,
      onClose: vi.fn(),
      onCreate: vi.fn(),
      onUpdate,
    };
    act(() => root.render(<AlertFormModal open alert={alert('a', 'Alert A')} {...common} />));
    expect((container.querySelector('label input') as HTMLInputElement).value).toBe('Alert A');

    act(() =>
      root.render(<AlertFormModal open={false} alert={alert('a', 'Alert A')} {...common} />),
    );
    act(() => root.render(<AlertFormModal open alert={alert('b', 'Alert B')} {...common} />));

    expect((container.querySelector('label input') as HTMLInputElement).value).toBe('Alert B');
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save',
    );
    act(() => save!.click());
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Alert B' }));
  });

  test('Scheduleの編集対象を切り替えるとnameとsavedQueryIdを再初期化する', () => {
    const onUpdate = vi.fn();
    const common = {
      datasources: [],
      savedQueries,
      submitting: false,
      serverError: null,
      onClose: vi.fn(),
      onCreate: vi.fn(),
      onUpdate,
    };
    act(() =>
      root.render(
        <ScheduleFormModal open schedule={schedule('a', 'Schedule A', 'saved-1')} {...common} />,
      ),
    );
    expect((container.querySelector('[name="name"]') as HTMLInputElement).value).toBe('Schedule A');

    act(() =>
      root.render(
        <ScheduleFormModal open schedule={schedule('b', 'Schedule B', 'saved-2')} {...common} />,
      ),
    );

    expect((container.querySelector('[name="name"]') as HTMLInputElement).value).toBe('Schedule B');
    expect((container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement).value).toBe(
      'saved-2',
    );
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save changes',
    );
    act(() => save!.click());
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Schedule B', savedQueryId: 'saved-2' }),
    );
  });

  test('Notebook保存を開き直すと新しい初期名を表示する', () => {
    const onConfirm = vi.fn();
    const common = { onClose: vi.fn(), onConfirm };
    act(() =>
      root.render(
        <SaveNotebookModal open targetId="notebook-a" initialName="Notebook A" {...common} />,
      ),
    );
    expect((container.querySelector('[name="name"]') as HTMLInputElement).value).toBe('Notebook A');

    act(() =>
      root.render(
        <SaveNotebookModal
          open={false}
          targetId="notebook-a"
          initialName="Notebook A"
          {...common}
        />,
      ),
    );
    act(() =>
      root.render(
        <SaveNotebookModal open targetId="notebook-b" initialName="Notebook B" {...common} />,
      ),
    );

    expect((container.querySelector('[name="name"]') as HTMLInputElement).value).toBe('Notebook B');
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save',
    );
    act(() => save!.click());
    expect(onConfirm).toHaveBeenCalledWith('Notebook B');
  });

  test('同名の別Notebookへ切り替えると入力状態を新しい対象へ再初期化する', () => {
    const onConfirmA = vi.fn();
    const onConfirmB = vi.fn();
    const common = { onClose: vi.fn() };
    act(() =>
      root.render(
        <SaveNotebookModal
          open
          targetId="notebook-a"
          initialName="Untitled notebook"
          onConfirm={onConfirmA}
          {...common}
        />,
      ),
    );
    const input = container.querySelector('[name="name"]') as HTMLInputElement;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setInputValue?.call(input, 'Name typed for first target');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('Name typed for first target');

    act(() =>
      root.render(
        <SaveNotebookModal
          open
          targetId="notebook-b"
          initialName="Untitled notebook"
          onConfirm={onConfirmB}
          {...common}
        />,
      ),
    );

    expect((container.querySelector('[name="name"]') as HTMLInputElement).value).toBe(
      'Untitled notebook',
    );
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save',
    );
    act(() => save!.click());
    expect(onConfirmA).not.toHaveBeenCalled();
    expect(onConfirmB).toHaveBeenCalledWith('Untitled notebook');
  });
});

// SaveQueryModal のテスト。表示、必須バリデーション、createSavedQuery への
// payload、成功時のモーダルクローズと一覧キャッシュ invalidate を検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { MAX_DESCRIPTION_LENGTH, MAX_IDENTIFIER_LENGTH, MAX_SQL_LENGTH } from '@hubble/contracts';
import { SaveQueryModal } from './SaveQueryModal';
import { ApiClientError } from '../../api/client';

vi.mock('../../api/savedQueries', () => ({
  createSavedQuery: vi.fn(),
}));

vi.mock('../common/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createSavedQuery } from '../../api/savedQueries';
import { toast } from '../common/Toast';

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

const datasources = [
  {
    id: 'warehouse-a',
    kind: 'trino' as const,
    displayName: 'Warehouse A',
    capabilities: { costEstimate: true, catalogs: true },
  },
];

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SaveQueryModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function renderModal(props: Partial<React.ComponentProps<typeof SaveQueryModal>> = {}) {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SaveQueryModal
            open
            statement="SELECT 1"
            context={{ datasourceId: 'warehouse-a', catalog: 'sales', schema: 'production' }}
            datasources={datasources}
            onClose={vi.fn()}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
    return { invalidateSpy };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('開くと名前/説明/SQLプレビュー/接続先を表示する', () => {
    renderModal();
    expect(container.querySelector('[aria-label="Saved query name"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Saved query description"]')).toBeTruthy();
    expect(container.textContent).toContain('SELECT 1');
    expect(container.textContent).toContain('Warehouse A');
    expect(container.textContent).toContain('sales.production');
  });

  test('名前が空だと保存ボタンが無効化される', () => {
    renderModal();
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'My query'));
    expect(save.disabled).toBe(false);
  });

  test('createSavedQueryを正しいpayloadで呼び出す(値の無いフィールドは省略)', async () => {
    vi.mocked(createSavedQuery).mockResolvedValue({
      id: 'sq-1',
      name: 'My query',
      description: '',
      statement: 'SELECT 1',
      isFavorite: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      owner: 'admin',
      myPermission: 'owner',
    });
    const onClose = vi.fn();
    const { invalidateSpy } = renderModal({
      context: {},
      onClose,
    });

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'My query'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(createSavedQuery).toHaveBeenCalledWith({
      name: 'My query',
      statement: 'SELECT 1',
    });
    expect(toast.success).toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['saved-queries', 'list'] });
    expect(onClose).toHaveBeenCalled();
  });

  test('コンテキストと説明を含めて送信する', async () => {
    vi.mocked(createSavedQuery).mockResolvedValue({
      id: 'sq-2',
      name: 'Context query',
      description: 'desc',
      statement: 'SELECT 1',
      catalog: 'sales',
      schema: 'production',
      datasourceId: 'warehouse-a',
      isFavorite: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      owner: 'admin',
      myPermission: 'owner',
    });
    renderModal();

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'Context query'));
    const descInput = container.querySelector(
      '[aria-label="Saved query description"]',
    ) as HTMLTextAreaElement;
    act(() => setInputValue(descInput, 'desc'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(createSavedQuery).toHaveBeenCalledWith({
      name: 'Context query',
      statement: 'SELECT 1',
      description: 'desc',
      datasourceId: 'warehouse-a',
      catalog: 'sales',
      schema: 'production',
    });
  });

  test('失敗時はエラートーストを出しモーダルを閉じない', async () => {
    vi.mocked(createSavedQuery).mockRejectedValue(
      new ApiClientError(400, { code: 'VALIDATION_ERROR', message: 'Name already too long' }),
    );
    const onClose = vi.fn();
    renderModal({ onClose });

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'My query'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(toast.error).toHaveBeenCalledWith('Save failed', 'Name already too long');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('descriptionが上限ちょうどなら送信できる(境界値)', async () => {
    vi.mocked(createSavedQuery).mockResolvedValue({
      id: 'sq-3',
      name: 'Boundary query',
      description: 'x'.repeat(MAX_DESCRIPTION_LENGTH),
      statement: 'SELECT 1',
      isFavorite: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      owner: 'admin',
      myPermission: 'owner',
    });
    renderModal({ context: {} });

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'Boundary query'));
    const descInput = container.querySelector(
      '[aria-label="Saved query description"]',
    ) as HTMLTextAreaElement;
    act(() => setInputValue(descInput, 'x'.repeat(MAX_DESCRIPTION_LENGTH)));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(createSavedQuery).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeFalsy();
  });

  test('descriptionが上限を1文字超えると送信されずエラー表示する', async () => {
    renderModal({ context: {} });

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'Too long description'));
    const descInput = container.querySelector(
      '[aria-label="Saved query description"]',
    ) as HTMLTextAreaElement;
    // maxLength 属性はユーザー入力(タイプ)にしか効かないため、テストでの直接の
    // value 代入では上限超過を再現できる。safeParse 側のガードを検証する。
    act(() => setInputValue(descInput, 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1)));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(createSavedQuery).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  test('statement(セルのSQL)が契約上限を超えると送信されずエラー表示する', async () => {
    renderModal({ context: {}, statement: 'x'.repeat(MAX_SQL_LENGTH + 1) });

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'Long statement'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(createSavedQuery).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  test('コンテキストの識別子(catalog)が契約上限を超えると送信されずエラー表示する', async () => {
    renderModal({
      context: { catalog: 'c'.repeat(MAX_IDENTIFIER_LENGTH + 1) },
    });

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'Long catalog'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(createSavedQuery).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  test('送信中に連打しても、createSavedQueryの呼び出しは1回だけ(二重送信防止)', async () => {
    // pending のまま解決しない Promise を返し、mutation.isPending が更新される
    // 前(同一ターン)の連打を再現する。
    vi.mocked(createSavedQuery).mockReturnValue(new Promise(() => {}));
    renderModal({ context: {} });

    const nameInput = container.querySelector(
      '[aria-label="Saved query name"]',
    ) as HTMLInputElement;
    act(() => setInputValue(nameInput, 'Double click query'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save query',
    ) as HTMLButtonElement;

    // 同一の act 呼び出し内(await を挟まず)で2回クリックする。mutate() の
    // 呼び出し自体は連打の時点で同期的に起きるため、この2クリックの間に
    // await は無い。act の後で内部マイクロタスクを一度だけ flush して、
    // 実際に呼ばれた createSavedQuery の回数を確定させる。
    await act(async () => {
      save.click();
      save.click();
    });

    expect(createSavedQuery).toHaveBeenCalledTimes(1);
  });
});

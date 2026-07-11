// workspace復元の成功、一時障害、恒久欠落と再試行時の永続化を検証する。
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Notebook } from '@hubble/contracts';
import { ApiClientError } from '../api/client';
import { useNotebookStore } from './notebookStore';
import {
  __resetWorkspaceRestoreForTest,
  restoreWorkspaceWithRetry,
  useNotebookWorkspace,
} from './useNotebookWorkspace';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('../components/common/Toast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

function makeNotebook(id: string): Notebook {
  const now = '2026-07-11T00:00:00.000Z';
  return {
    id,
    revision: 1,
    name: id,
    description: '',
    cells: [],
    variables: [],
    context: {},
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  useNotebookStore.setState({ open: {}, openIds: [], activeId: null });
  localStorage.clear();
  localStorage.setItem(
    'hubble-workspace',
    JSON.stringify({ version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] }),
  );
});

describe('restoreWorkspaceWithRetry', () => {
  test.each([
    ['network failure', new TypeError('Failed to fetch')],
    [
      'server failure',
      new ApiClientError(503, { code: 'HTTP_ERROR', message: 'temporarily unavailable' }),
    ],
  ])('preserves the snapshot on %s', async (_name, error) => {
    const fetchNotebook = vi.fn<(_id: string) => Promise<Notebook>>().mockRejectedValue(error);

    const status = await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] },
      [],
      {},
      { fetchNotebook, onUnavailable: vi.fn(), scheduleRetry: vi.fn() },
    );

    expect(status).toBe('temporarily-unavailable');
    expect(useNotebookStore.getState().openIds).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).toContain('saved');
  });

  test('全notebookがHTTP 401でもsnapshotを上書きしない', async () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({
        version: 1,
        openIds: ['first', 'second'],
        activeId: 'second',
        draftIds: [],
      }),
    );
    const fetchNotebook = vi
      .fn<(_id: string) => Promise<Notebook>>()
      .mockRejectedValue(new ApiClientError(401, { code: 'HTTP_ERROR', message: 'unauthorized' }));

    const result = await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['first', 'second'], activeId: 'second', draftIds: [] },
      [],
      {},
      { fetchNotebook, onUnavailable: vi.fn(), scheduleRetry: vi.fn() },
    );

    expect(result).toBe('temporarily-unavailable');
    expect(fetchNotebook).toHaveBeenCalledTimes(2);
    expect(useNotebookStore.getState().openIds).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).toEqual(
      expect.arrayContaining(['first', 'second']),
    );
  });

  test.each([403, 404])('treats HTTP %i as permanently unavailable', async (status) => {
    const fetchNotebook = vi
      .fn<(_id: string) => Promise<Notebook>>()
      .mockRejectedValue(new ApiClientError(status, { code: 'HTTP_ERROR', message: 'gone' }));

    const result = await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] },
      [],
      { catalog: 'memory' },
      { fetchNotebook, onUnavailable: vi.fn(), scheduleRetry: vi.fn() },
    );

    expect(result).toBe('restored');
    const state = useNotebookStore.getState();
    expect(state.openIds).toHaveLength(1);
    expect(state.open[state.openIds[0]!]!.draft).toBe(true);
  });

  test('restores successful saved notebooks in snapshot order', async () => {
    const fetchNotebook = vi.fn(async (id: string) => makeNotebook(id));

    const result = await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['first', 'second'], activeId: 'first', draftIds: [] },
      [],
      {},
      { fetchNotebook, onUnavailable: vi.fn(), scheduleRetry: vi.fn() },
    );

    expect(result).toBe('restored');
    expect(useNotebookStore.getState().openIds).toEqual(['first', 'second']);
    expect(useNotebookStore.getState().activeId).toBe('first');
  });

  test('一時障害を通知してから同じsnapshotを再試行する', async () => {
    const fetchNotebook = vi
      .fn<(_id: string) => Promise<Notebook>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(makeNotebook('saved'));
    const onUnavailable = vi.fn();
    let retry: (() => Promise<void>) | undefined;

    const status = await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] },
      [],
      {},
      {
        fetchNotebook,
        onUnavailable,
        scheduleRetry: (scheduled) => {
          retry = scheduled;
        },
      },
    );

    expect(status).toBe('temporarily-unavailable');
    expect(onUnavailable).toHaveBeenCalledOnce();
    const blankId = useNotebookStore.getState().openIds[0]!;
    expect(useNotebookStore.getState().open[blankId]?.draft).toBe(true);
    await retry?.();
    expect(useNotebookStore.getState().openIds).toEqual([blankId, 'saved']);
    expect(useNotebookStore.getState().activeId).toBe('saved');
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).activeId).toBe('saved');
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  test('成功タブを即時復元し、操作中も一時障害タブをsnapshotへ保持する', async () => {
    const fetchNotebook = vi.fn(async (id: string) => {
      if (
        id === 'second' &&
        fetchNotebook.mock.calls.filter(([called]) => called === id).length < 2
      ) {
        throw new TypeError('offline');
      }
      return makeNotebook(id);
    });
    let retry: (() => Promise<void>) | undefined;

    await restoreWorkspaceWithRetry(
      {
        version: 1,
        openIds: ['first', 'second'],
        activeId: 'second',
        draftIds: [],
      },
      [],
      {},
      {
        fetchNotebook,
        onUnavailable: vi.fn(),
        scheduleRetry: (scheduled) => {
          retry = scheduled;
        },
      },
    );

    expect(useNotebookStore.getState().openIds).toEqual(['first']);
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).toEqual([
      'first',
      'second',
    ]);
    useNotebookStore.getState().openNotebook(makeNotebook('user-opened'));
    useNotebookStore.getState().setActive('user-opened');
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).toEqual([
      'first',
      'second',
      'user-opened',
    ]);

    await retry?.();
    expect(useNotebookStore.getState().openIds).toEqual(['first', 'second', 'user-opened']);
    expect(useNotebookStore.getState().activeId).toBe('user-opened');
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).toEqual([
      'first',
      'second',
      'user-opened',
    ]);
  });

  test('破損draftのrawを残してworkspace参照を除く', async () => {
    localStorage.setItem('hubble-draft:legacy-broken', '{"id":"legacy-broken"}');
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({
        version: 1,
        openIds: ['legacy-broken'],
        activeId: 'legacy-broken',
        draftIds: ['legacy-broken'],
      }),
    );

    const { readDraftRestoreResult, readWorkspaceSnapshot } = await import('./notebookStore');
    const result = readDraftRestoreResult();
    const persisted = readWorkspaceSnapshot();

    expect(result.corruptIds).toEqual(['legacy-broken']);
    expect(persisted?.openIds).not.toContain('legacy-broken');
    expect(persisted?.draftIds).not.toContain('legacy-broken');
    expect(localStorage.getItem('hubble-draft:legacy-broken')).toBe('{"id":"legacy-broken"}');
  });

  test('一時障害の再試行を5回で打ち切る', async () => {
    const fetchNotebook = vi.fn().mockRejectedValue(new TypeError('offline'));
    const onGiveUp = vi.fn();
    let scheduled: (() => Promise<void>) | undefined;

    await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] },
      [],
      {},
      {
        fetchNotebook,
        onUnavailable: vi.fn(),
        onGiveUp,
        scheduleRetry: (retry) => {
          scheduled = retry;
        },
      },
    );
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const retry = scheduled;
      scheduled = undefined;
      await retry?.();
    }

    expect(fetchNotebook).toHaveBeenCalledTimes(5);
    expect(onGiveUp).toHaveBeenCalledWith(['saved']);
    expect(scheduled).toBeUndefined();
    useNotebookStore.getState().openNotebook(makeNotebook('after-give-up'));
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).toEqual([
      ...useNotebookStore.getState().openIds,
      'saved',
    ]);

    useNotebookStore.getState().openNotebook(makeNotebook('saved'));
    useNotebookStore.getState().openNotebook(makeNotebook('final-active'));
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).activeId).toBe('final-active');
    useNotebookStore.getState().closeNotebook('saved');
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).not.toContain('saved');
  });

  test('リトライ前に手動で開いたタブの位置を変えない', async () => {
    const fetchNotebook = vi
      .fn<(_id: string) => Promise<Notebook>>()
      .mockRejectedValueOnce(new TypeError('offline'));
    let retry: (() => Promise<void>) | undefined;

    await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] },
      [],
      {},
      {
        fetchNotebook,
        onUnavailable: vi.fn(),
        scheduleRetry: (scheduled) => {
          retry = scheduled;
        },
      },
    );

    const blankId = useNotebookStore.getState().openIds[0]!;
    useNotebookStore.getState().openNotebook(makeNotebook('saved'));
    useNotebookStore.getState().openNotebook(makeNotebook('after'));
    expect(useNotebookStore.getState().openIds).toEqual([blankId, 'saved', 'after']);

    await retry?.();

    expect(fetchNotebook).toHaveBeenCalledOnce();
    expect(useNotebookStore.getState().openIds).toEqual([blankId, 'saved', 'after']);
  });

  test('リトライ待ちに閉じたタブを再オープンしない', async () => {
    const fetchNotebook = vi
      .fn<(_id: string) => Promise<Notebook>>()
      .mockRejectedValueOnce(new TypeError('offline'));
    let retry: (() => Promise<void>) | undefined;

    await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] },
      [],
      {},
      {
        fetchNotebook,
        onUnavailable: vi.fn(),
        scheduleRetry: (scheduled) => {
          retry = scheduled;
        },
      },
    );

    useNotebookStore.getState().openNotebook(makeNotebook('saved'));
    useNotebookStore.getState().closeNotebook('saved');
    await retry?.();

    expect(fetchNotebook).toHaveBeenCalledOnce();
    expect(useNotebookStore.getState().openIds).not.toContain('saved');
    const persisted = JSON.parse(localStorage.getItem('hubble-workspace')!);
    expect(persisted.openIds).not.toContain('saved');
  });

  test('未解決のactiveIdとタブ位置をsnapshotどおり保持する', async () => {
    const fetchNotebook = vi.fn(async (id: string) => {
      if (id === 'second') throw new TypeError('offline');
      return makeNotebook(id);
    });

    await restoreWorkspaceWithRetry(
      {
        version: 1,
        openIds: ['first', 'second', 'third'],
        activeId: 'second',
        draftIds: [],
      },
      [],
      {},
      { fetchNotebook, onUnavailable: vi.fn(), scheduleRetry: vi.fn() },
    );

    const persisted = JSON.parse(localStorage.getItem('hubble-workspace')!);
    expect(persisted.openIds).toEqual(['first', 'second', 'third']);
    expect(persisted.activeId).toBe('second');
  });

  test('初回fetch中のユーザーactivationを復元完了時に上書きしない', async () => {
    const resolvers = new Map<string, (notebook: Notebook) => void>();
    const fetchNotebook = vi.fn(
      (id: string) =>
        new Promise<Notebook>((resolve) => {
          resolvers.set(id, resolve);
        }),
    );
    const restoring = restoreWorkspaceWithRetry(
      { version: 1, openIds: ['first', 'second'], activeId: 'second', draftIds: [] },
      [],
      {},
      { fetchNotebook, onUnavailable: vi.fn(), scheduleRetry: vi.fn() },
    );
    await vi.waitFor(() => expect(fetchNotebook).toHaveBeenCalledTimes(2));
    useNotebookStore.getState().openNotebook(makeNotebook('user-active'));

    resolvers.get('first')!(makeNotebook('first'));
    resolvers.get('second')!(makeNotebook('second'));
    await restoring;

    expect(useNotebookStore.getState().activeId).toBe('user-active');
    expect(JSON.parse(localStorage.getItem('hubble-workspace')!).openIds).toEqual([
      'first',
      'second',
      'user-active',
    ]);
  });

  test('retry fetch中に手動で開いた同一タブの位置を変えない', async () => {
    let resolveFetch!: (notebook: Notebook) => void;
    const fetchNotebook = vi
      .fn<(_id: string) => Promise<Notebook>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockImplementationOnce(
        () =>
          new Promise<Notebook>((resolve) => {
            resolveFetch = resolve;
          }),
      );
    let retry: (() => Promise<void>) | undefined;
    await restoreWorkspaceWithRetry(
      { version: 1, openIds: ['saved'], activeId: 'saved', draftIds: [] },
      [],
      {},
      {
        fetchNotebook,
        onUnavailable: vi.fn(),
        scheduleRetry: (scheduled) => {
          retry = scheduled;
        },
      },
    );
    const retrying = retry?.();
    await vi.waitFor(() => expect(fetchNotebook).toHaveBeenCalledTimes(2));
    const blankId = useNotebookStore.getState().openIds[0]!;
    useNotebookStore.getState().closeNotebook(blankId);
    useNotebookStore.getState().openNotebook(makeNotebook('before'));
    useNotebookStore.getState().openNotebook(makeNotebook('saved'));
    useNotebookStore.getState().openNotebook(makeNotebook('after'));

    resolveFetch(makeNotebook('saved'));
    await retrying;

    expect(useNotebookStore.getState().openIds).toEqual(['before', 'saved', 'after']);
  });

  test('保存済みタブを並列取得してsnapshot順に適用する', async () => {
    const resolvers = new Map<string, (notebook: Notebook) => void>();
    const fetchNotebook = vi.fn(
      (id: string) =>
        new Promise<Notebook>((resolve) => {
          resolvers.set(id, resolve);
        }),
    );
    const restoring = restoreWorkspaceWithRetry(
      { version: 1, openIds: ['first', 'second', 'third'], activeId: 'first', draftIds: [] },
      [],
      {},
      { fetchNotebook, onUnavailable: vi.fn(), scheduleRetry: vi.fn() },
    );

    await vi.waitFor(() => expect(fetchNotebook).toHaveBeenCalledTimes(3));
    resolvers.get('third')!(makeNotebook('third'));
    resolvers.get('first')!(makeNotebook('first'));
    resolvers.get('second')!(makeNotebook('second'));
    await restoring;

    expect(useNotebookStore.getState().openIds).toEqual(['first', 'second', 'third']);
  });
});

function WorkspaceHookHarness() {
  useNotebookWorkspace({});
  return null;
}

async function renderWorkspaceHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(WorkspaceHookHarness),
      ),
    );
    await Promise.resolve();
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useNotebookWorkspace toast gating', () => {
  beforeEach(() => {
    __resetWorkspaceRestoreForTest();
    toastError.mockClear();
    useNotebookStore.setState({ open: {}, openIds: [], activeId: null });
    localStorage.clear();
  });

  test('fresh profileではエラートーストを出さない', async () => {
    const rendered = await renderWorkspaceHook();
    await vi.waitFor(() => expect(useNotebookStore.getState().openIds).toHaveLength(1));

    expect(toastError).not.toHaveBeenCalled();
    rendered.unmount();
  });

  test('破損draftをworkspaceから外したときだけ1件通知する', async () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({
        version: 1,
        openIds: ['broken'],
        activeId: 'broken',
        draftIds: ['broken'],
      }),
    );
    localStorage.setItem('hubble-draft:broken', '{broken');

    const rendered = await renderWorkspaceHook();
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce());

    expect(toastError).toHaveBeenCalledWith(
      'Corrupt draft removed',
      expect.stringContaining('may be cleaned up later'),
    );
    rendered.unmount();
  });
});

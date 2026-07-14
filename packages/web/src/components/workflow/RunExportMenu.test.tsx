/**
 * ワークフロー一括ダウンロードの成功、HTTP エラー、通信失敗を検証する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RunExportMenu } from './RunExportMenu';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: toastError,
    info: vi.fn(),
  },
}));

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function selectOption(container: HTMLElement, label: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
  if (!trigger) throw new Error('missing export trigger');
  act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const option = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!option) throw new Error(`missing export option: ${label}`);
  act(() => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flushPromises();
}

describe('RunExportMenu downloads', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let createObjectUrl: ReturnType<typeof vi.spyOn>;
  let anchorClick: ReturnType<typeof vi.spyOn>;
  let initialHref: string;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hubble-run');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    toastError.mockReset();
    initialHref = window.location.href;
    act(() => root.render(<RunExportMenu runId="run-1" disabled={false} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('downloads a successful CSV zip without navigating the SPA', async () => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValue(pending.promise);

    await selectOption(container, 'CSV (zip)');
    expect(container.firstElementChild?.className).toContain('pointer-events-none');

    pending.resolve(
      new Response(new Blob(['zip']), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
    );
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/api/workflow-runs/run-1/download.zip');
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('workflow-run-run-1.zip');
    expect(window.location.href).toBe(initialHref);
    expect(container.firstElementChild?.className).not.toContain('pointer-events-none');
  });

  test('shows a 404 API error without downloading or navigating', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'RESULT_NOT_PERSISTED',
            message: 'No persisted step results are available',
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );

    await selectOption(container, 'Excel (multi-sheet)');

    expect(toastError).toHaveBeenCalledWith(
      'Export failed',
      'No persisted step results are available',
    );
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialHref);
    expect(container.firstElementChild?.className).not.toContain('pointer-events-none');
  });

  test('shows a network error without downloading or leaving busy state behind', async () => {
    fetchMock.mockRejectedValue(new TypeError('network unavailable'));

    await selectOption(container, 'CSV (zip)');

    expect(toastError).toHaveBeenCalledWith('Export failed', 'Could not reach the server.');
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialHref);
    expect(container.firstElementChild?.className).not.toContain('pointer-events-none');
  });
});

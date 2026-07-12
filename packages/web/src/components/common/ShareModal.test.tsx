// 共有一覧の取得状態と全置換保存の安全条件を検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DocumentShare } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ShareModal } from './ShareModal';

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`${label} button was not rendered`);
  return match;
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

describe('ShareModal', () => {
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

  test('取得失敗を空の共有一覧として保存せずRetryを提示する', async () => {
    const fetchShares = vi.fn().mockRejectedValue(new Error('temporary failure'));
    const updateShares = vi.fn();

    await act(async () => {
      root.render(
        <ShareModal
          open
          onClose={vi.fn()}
          documentName="Owned document"
          fetchShares={fetchShares}
          updateShares={updateShares}
        />,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain('Could not load shares.'));

    const save = button(container, 'Save');
    expect(save.disabled).toBe(true);
    expect(button(container, 'Retry')).toBeDefined();
    expect(container.querySelector('[aria-label="Share subject row 1"]')).toBeNull();
    save.click();
    expect(updateShares).not.toHaveBeenCalled();
  });

  test('Retryの取得成功後だけ既存の共有一覧を編集可能にする', async () => {
    const existingShare: DocumentShare = {
      subjectType: 'user',
      subjectValue: 'alice@example.com',
      permission: 'edit',
      createdAt: '2026-07-12T00:00:00.000Z',
    };
    const fetchShares = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ shares: [existingShare] });

    await act(async () => {
      root.render(
        <ShareModal
          open
          onClose={vi.fn()}
          documentName="Owned document"
          fetchShares={fetchShares}
          updateShares={vi.fn()}
        />,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain('Could not load shares.'));

    await act(async () => {
      button(container, 'Retry').click();
    });
    await vi.waitFor(() => {
      const subject = container.querySelector<HTMLInputElement>(
        '[aria-label="Share subject row 1"]',
      );
      expect(subject?.value).toBe('alice@example.com');
    });

    expect(fetchShares).toHaveBeenCalledTimes(2);
    expect(button(container, 'Save').disabled).toBe(false);
  });
});

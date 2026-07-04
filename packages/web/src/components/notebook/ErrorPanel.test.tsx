import { afterEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { ErrorPanel } from './ErrorPanel';

describe('ErrorPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('shows a friendly message for WRITE_NOT_ALLOWED', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ErrorPanel
          error={{
            code: WRITE_NOT_ALLOWED,
            message: '読み取り専用ロールのため書き込み文は実行できません。',
          }}
        />,
      );
    });
    const panel = container.querySelector('[data-error-code="WRITE_NOT_ALLOWED"]');
    expect(panel).not.toBeNull();
    expect(container.textContent).toContain('読み取り専用ロールのため');
  });
});

import { afterEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { ErrorPanel } from './ErrorPanel';
import { LocaleProvider } from '../../i18n/locale';

/**
 * navigator.language を固定して LocaleProvider の初期ロケールを日本語にする
 * （i18nAccessibleName.test.tsx の withLocale と同じ手法）。
 */
function withJapaneseLocale(fn: () => void): void {
  Object.defineProperty(window.navigator, 'language', {
    value: 'ja-JP',
    configurable: true,
  });
  window.localStorage.clear();
  fn();
}

describe('ErrorPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('shows a friendly message for WRITE_NOT_ALLOWED (デフォルトの英語ロケール)', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ErrorPanel
          error={{
            code: WRITE_NOT_ALLOWED,
            message: 'Write statements are not allowed for read-only roles.',
          }}
        />,
      );
    });
    const panel = container.querySelector('[data-error-code="WRITE_NOT_ALLOWED"]');
    expect(panel).not.toBeNull();
    // LocaleProvider の外側では useLocale() が英語をデフォルトにするため、
    // 案内文言も英語で表示される。
    expect(container.textContent).toContain('This SQL cannot run');
  });

  test('shows a friendly message for WRITE_NOT_ALLOWED (日本語ロケール)', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    withJapaneseLocale(() => {
      act(() => {
        root.render(
          <LocaleProvider>
            <ErrorPanel
              error={{
                code: WRITE_NOT_ALLOWED,
                message: '読み取り専用ロールのため書き込み文は実行できません。',
              }}
            />
          </LocaleProvider>,
        );
      });
    });
    const panel = container.querySelector('[data-error-code="WRITE_NOT_ALLOWED"]');
    expect(panel).not.toBeNull();
    expect(container.textContent).toContain('読み取り専用ロールのため');
  });
});

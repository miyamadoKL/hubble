// LocaleProvider の初期値決定（localStorage 優先 → navigator.language フォールバック）と、
// setLocale による切替 + 永続化 + <html lang> 更新を検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { LocaleProvider, useLocale } from './locale';

/** 現在のロケールを表示し、切替ボタンを持つだけの検証用コンポーネント。 */
function Probe() {
  const { locale, setLocale } = useLocale();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <button type="button" onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')}>
        toggle
      </button>
    </div>
  );
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

describe('LocaleProvider / useLocale', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('localStorage に保存済みの値があれば navigator.language より優先する', () => {
    window.localStorage.setItem('hubble-locale', 'en');
    Object.defineProperty(window.navigator, 'language', { value: 'ja-JP', configurable: true });

    act(() =>
      root.render(
        <LocaleProvider>
          <Probe />
        </LocaleProvider>,
      ),
    );

    expect(container.querySelector('[data-testid="locale"]')!.textContent).toBe('en');
  });

  test('localStorage が空なら navigator.language が ja 系のとき ja になる', () => {
    Object.defineProperty(window.navigator, 'language', { value: 'ja-JP', configurable: true });

    act(() =>
      root.render(
        <LocaleProvider>
          <Probe />
        </LocaleProvider>,
      ),
    );

    expect(container.querySelector('[data-testid="locale"]')!.textContent).toBe('ja');
  });

  test('localStorage が空で navigator.language が非日本語なら en になる', () => {
    Object.defineProperty(window.navigator, 'language', { value: 'fr-FR', configurable: true });

    act(() =>
      root.render(
        <LocaleProvider>
          <Probe />
        </LocaleProvider>,
      ),
    );

    expect(container.querySelector('[data-testid="locale"]')!.textContent).toBe('en');
  });

  test('setLocale で切替 + localStorage への永続化 + <html lang> の更新を行う', () => {
    Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true });

    act(() =>
      root.render(
        <LocaleProvider>
          <Probe />
        </LocaleProvider>,
      ),
    );
    expect(container.querySelector('[data-testid="locale"]')!.textContent).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    act(() => container.querySelector('button')!.click());

    expect(container.querySelector('[data-testid="locale"]')!.textContent).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(window.localStorage.getItem('hubble-locale')).toBe('ja');
  });
});

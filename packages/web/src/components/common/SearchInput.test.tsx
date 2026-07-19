// SearchInput のアクセシブルネーム(aria-label)がプレースホルダーと同じ翻訳済み文言に
// なること、呼び出し元が明示的に aria-label を渡した場合はそちらが優先されることを検証する
// （レビュー指摘: placeholder だけでは支援技術に検索欄の目的が伝わらない）。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SearchInput } from './SearchInput';

describe('SearchInput のアクセシブルネーム', () => {
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

  test('placeholder を渡した場合、aria-label も同じ文言になる', () => {
    act(() => {
      root.render(
        <SearchInput value="" onChange={() => undefined} placeholder="ノートブックを検索…" />,
      );
    });
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('ノートブックを検索…');
    expect(input.getAttribute('placeholder')).toBe('ノートブックを検索…');
  });

  test('placeholder 省略時は、ロケール既定文言（Provider の外側では en）が aria-label になる', () => {
    act(() => {
      root.render(<SearchInput value="" onChange={() => undefined} />);
    });
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('Search…');
  });

  test('呼び出し元が明示的に aria-label を渡した場合はそちらを優先する', () => {
    act(() => {
      root.render(
        <SearchInput
          value=""
          onChange={() => undefined}
          placeholder="Search notebooks…"
          aria-label="Custom label"
        />,
      );
    });
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('Custom label');
  });
});

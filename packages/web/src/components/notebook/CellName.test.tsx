/**
 * CellToolbar のセル名インライン編集で、表示用 <button> と編集用 <input> の幅が一致する
 * ことを検証する回帰テスト。
 *
 * 実ブラウザ(Chromium)で長いセル名を使って計測したところ、表示用 <button> は flex
 * アイテムとして内容幅ぶん伸縮し（`truncate` はコンテナ側に幅の制約がないと効かない）、
 * 編集用 <input> の固定 w-40（160px）との差が最大で 170px を超えていた。button 側にも
 * w-40 を与えて幅を揃える(詳細な計測は e2e/tests/notebookHeaderLayout.spec.ts の
 * 「a long cell name keeps the same box width」テストを参照。あちらが一次的な検証手段で
 * あり、ここでの className アサーションは jsdom でも高速に検出できる補助的な不変条件)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CellName } from './CellToolbar';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('CellName display/edit width', () => {
  it('gives the display <button> the same w-40 width as the edit <input> (named cell)', () => {
    act(() => {
      root.render(<CellName name="Orders" onRename={() => {}} />);
    });

    const displayButton = container.querySelector('button');
    expect(displayButton).not.toBeNull();
    expect(displayButton!.className.split(/\s+/)).toContain('w-40');

    act(() => {
      const evt = new MouseEvent('dblclick', { bubbles: true });
      displayButton!.dispatchEvent(evt);
    });

    const editInput = container.querySelector('input[aria-label="Cell name"]');
    expect(editInput).not.toBeNull();
    expect(editInput!.className.split(/\s+/)).toContain('w-40');
  });

  it('gives the display <button> the same w-40 width for the "Untitled cell" placeholder', () => {
    act(() => {
      root.render(<CellName onRename={() => {}} />);
    });

    const displayButton = container.querySelector('button');
    expect(displayButton).not.toBeNull();
    expect(displayButton!.className.split(/\s+/)).toContain('w-40');
  });
});

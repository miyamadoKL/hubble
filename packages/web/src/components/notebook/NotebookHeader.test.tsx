/**
 * NotebookHeader の説明フィールドで、表示用 <p> と編集用 <input> の実際の描画位置が
 * 「Add a description…」クリックのたびにずれる問題の回帰を防ぐ。
 *
 * 実ブラウザ(Chromium)で getBoundingClientRect() を計測したところ、line-height、
 * font-size、height、padding、border、margin は <p> と <input> で完全に一致していたが、
 * 上端の位置だけ 3px ずれていた。原因は <input> の既定 display: inline-block にある:
 * 親要素がインラインフォーマッティングコンテキストを作り、匿名 line box の strut ぶんの
 * 余白が上に入る。<input> に block を指定するとこの余白が消え、<p> と同じ margin ベースの
 * 配置になることを実測で確認した(詳細は e2e/tests/notebookHeaderLayout.spec.ts の
 * getBoundingClientRect ベースの回帰テストを参照。あちらが一次的な検証手段であり、
 * ここでの className アサーションは jsdom でも高速に検出できる補助的な不変条件)。
 *
 * jsdom は実レイアウトを計算しないため display の値そのものは検証できないが、修正が
 * 「編集用 <input> に block クラスを付与する」という具体的な形を取っている以上、
 * そのクラスが実際に付いていることを検証すれば、将来の変更でこの className が
 * うっかり落とされた場合に検出できる。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotebookHeader } from './NotebookView';

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

function renderHeader(description: string) {
  act(() => {
    root.render(
      <NotebookHeader
        name="My notebook"
        description={description}
        readOnly={false}
        canShare={false}
        onShare={() => {}}
        onRename={() => {}}
        onDescribe={() => {}}
      />,
    );
  });
}

describe('NotebookHeader description edit box', () => {
  it('gives the edit <input> an explicit block display, matching the display <p>', () => {
    renderHeader('Some description');

    const displayDesc = container.querySelector('p[title="Click to edit description"]');
    expect(displayDesc).not.toBeNull();

    act(() => {
      (displayDesc as HTMLElement).click();
    });

    const editDesc = container.querySelector('input[aria-label="Notebook description"]');
    expect(editDesc).not.toBeNull();
    // <input> は既定で display: inline-block になり、<p>（display: block）と
    // インラインフォーマッティングコンテキストの扱いが変わって高さがずれる。
    // block クラスで明示的に <p> と同じ表示種別に揃える。
    expect(editDesc!.className.split(/\s+/)).toContain('block');
  });

  it('gives the edit <input> a block display even when the placeholder row is empty', () => {
    renderHeader('');

    const displayDesc = container.querySelector('p[title="Click to edit description"]');
    expect(displayDesc).not.toBeNull();

    act(() => {
      (displayDesc as HTMLElement).click();
    });

    const editDesc = container.querySelector('input[aria-label="Notebook description"]');
    expect(editDesc).not.toBeNull();
    expect(editDesc!.className.split(/\s+/)).toContain('block');
  });
});

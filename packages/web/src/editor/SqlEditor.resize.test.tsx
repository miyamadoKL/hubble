/**
 * SqlEditor の高さ手動オーバーライドハンドル（pointer ドラッグ、ダブルクリックでの
 * 自動伸縮復帰、キーボード操作、localStorage 永続化）を検証する。Monaco 本体は
 * SqlEditor.test.tsx と同じ方針で最小限にモックする（実際のレイアウト計算はしない）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadMonaco } from './monacoLoader';
import { useEditorRuntime } from './EditorRuntime';
import { useUiStore } from '../stores/uiStore';
import {
  EDITOR_HEIGHT_MIN,
  editorHeightMax,
  editorHeightsStorageKey,
  getEditorHeight,
} from '../notebook/editorHeight';

vi.mock('./registerTrinoLanguage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registerTrinoLanguage')>();
  return {
    ...actual,
    registerTrinoLanguage: vi.fn(),
    attachDiagnostics: vi.fn(() => ({ dispose: vi.fn() })),
  };
});

vi.mock('./monacoLoader', () => ({
  loadMonaco: vi.fn(),
}));

vi.mock('./EditorRuntime', () => ({
  useEditorRuntime: vi.fn(),
}));

vi.mock('../stores/uiStore', () => ({
  useUiStore: vi.fn(),
}));

vi.mock('./theme', () => ({
  applyFableTheme: vi.fn(),
}));

import { SqlEditor } from './SqlEditor';

// getLineCount は常に4行固定（= 自動伸縮時は常にEDITOR_HEIGHT_MIN=96px）にして、
// 高さの変化がすべて手動オーバーライドによるものだと判定しやすくする。
const model = { getLineCount: () => 4 };

const editor = {
  getModel: () => model,
  getValue: () => 'SELECT 1',
  onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
  onDidContentSizeChange: vi.fn(() => ({ dispose: vi.fn() })),
  dispose: vi.fn(),
  setValue: vi.fn(),
};

const monacoNs = {
  editor: {
    create: vi.fn(() => editor),
    setModelLanguage: vi.fn(),
    setModelMarkers: vi.fn(),
  },
};

function runtime(): ReturnType<typeof useEditorRuntime> {
  return {
    cache: {} as ReturnType<typeof useEditorRuntime>['cache'],
    getContext: () => ({}),
    getDatasourceId: () => 'trino-default',
    isTrinoLanguage: () => true,
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForReady(host: HTMLElement) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (host.querySelector('[data-ready="true"]')) return;
    await flushPromises();
  }
  throw new Error('SqlEditor did not become ready');
}

/** clientY / pointerId を持つ擬似 PointerEvent を作る（jsdom は PointerEvent 未実装のため）。 */
function pointerEvent(type: string, coords: { clientY?: number; pointerId?: number }): Event {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  if (coords.clientY !== undefined)
    Object.defineProperty(event, 'clientY', { value: coords.clientY });
  if (coords.pointerId !== undefined)
    Object.defineProperty(event, 'pointerId', { value: coords.pointerId });
  return event;
}

function heightHandle(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-orientation="horizontal"]') as HTMLElement;
}

function editorHost(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="sql-editor"]') as HTMLElement;
}

/**
 * 指定した行数（lineCount）で自動伸縮した状態を再現するための、専用の
 * model/editor/monacoNs モックを組んで loadMonaco をその回だけ差し替える。
 * 40行超えのケース（MAX_LINESクランプ）を検証するために使う。
 */
function mockLoadMonacoWithLineCount(lineCount: number): void {
  const wideModel = { getLineCount: () => lineCount };
  const wideEditor = {
    getModel: () => wideModel,
    getValue: () => 'SELECT 1',
    onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
    onDidContentSizeChange: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    setValue: vi.fn(),
  };
  const wideMonacoNs = {
    editor: {
      create: vi.fn(() => wideEditor),
      setModelLanguage: vi.fn(),
      setModelMarkers: vi.fn(),
    },
  };
  vi.mocked(loadMonaco).mockResolvedValueOnce(
    wideMonacoNs as unknown as typeof import('monaco-editor'),
  );
}

describe('SqlEditor height override handle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.mocked(loadMonaco).mockResolvedValue(monacoNs as unknown as typeof import('monaco-editor'));
    vi.mocked(useEditorRuntime).mockImplementation(runtime);
    vi.mocked(useUiStore).mockImplementation(((selector: (s: { theme: string }) => unknown) =>
      selector({ theme: 'dark' })) as typeof useUiStore);
    monacoNs.editor.create.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
  });

  test('ハンドルは常時表示され、グリップが常に見えるスタイルを持つ', async () => {
    act(() => {
      root.render(<SqlEditor value="SELECT 1" />);
    });
    await waitForReady(container);

    const handle = heightHandle(container);
    expect(handle).not.toBeNull();
    expect(handle.className).toContain('touch-none');
    // グリップ本体（子要素）は常時 bg-border-base を持ち、hover時のみ強調される
    // transition-colors とは別に、透明ではない状態が既定であることを確認する。
    const grip = handle.querySelector('span');
    expect(grip?.className).toContain('bg-border-base');
    expect(grip?.className).not.toContain('bg-transparent');
  });

  test('notebookId/cellId未指定でもドラッグで高さが変わる（永続化はしない）', async () => {
    act(() => {
      root.render(<SqlEditor value="SELECT 1" />);
    });
    await waitForReady(container);

    const handle = heightHandle(container);
    const host = editorHost(container);
    const before = host.style.height;

    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, pointerId: 1 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 500, pointerId: 1 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 })));

    expect(host.style.height).not.toBe(before);
  });

  test('ドラッグすると高さが変わり、notebookId/cellIdがあればlocalStorageへ永続化される', async () => {
    act(() => {
      root.render(<SqlEditor value="SELECT 1" notebookId="nb-1" cellId="cell-1" />);
    });
    await waitForReady(container);

    const handle = heightHandle(container);
    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, pointerId: 1 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 500, pointerId: 1 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 })));

    const host = editorHost(container);
    expect(host.style.height).toBe(`${EDITOR_HEIGHT_MIN + 200}px`);
    expect(getEditorHeight('nb-1', 'cell-1')).toBe(EDITOR_HEIGHT_MIN + 200);
    expect(localStorage.getItem(editorHeightsStorageKey('nb-1'))).not.toBeNull();
  });

  test('ダブルクリックで自動伸縮へ戻り、localStorageのエントリが解除される', async () => {
    act(() => {
      root.render(<SqlEditor value="SELECT 1" notebookId="nb-1" cellId="cell-1" />);
    });
    await waitForReady(container);

    const handle = heightHandle(container);
    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, pointerId: 1 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 500, pointerId: 1 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 })));
    expect(getEditorHeight('nb-1', 'cell-1')).not.toBeNull();

    act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

    const host = editorHost(container);
    // 自動伸縮時はモデルの行数（固定4行）に応じたEDITOR_HEIGHT_MIN相当に戻る。
    expect(host.style.height).toBe(`${EDITOR_HEIGHT_MIN}px`);
    expect(getEditorHeight('nb-1', 'cell-1')).toBeNull();
  });

  test('矢印キーで16px刻みに調整され、既定動作はpreventDefaultされる', async () => {
    act(() => {
      root.render(<SqlEditor value="SELECT 1" notebookId="nb-1" cellId="cell-1" />);
    });
    await waitForReady(container);

    const handle = heightHandle(container);
    expect(handle.getAttribute('aria-valuenow')).toBe(String(EDITOR_HEIGHT_MIN));

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    act(() => handle.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(handle.getAttribute('aria-valuenow')).toBe(String(EDITOR_HEIGHT_MIN + 16));
    expect(editorHost(container).style.height).toBe(`${EDITOR_HEIGHT_MIN + 16}px`);
    expect(getEditorHeight('nb-1', 'cell-1')).toBe(EDITOR_HEIGHT_MIN + 16);
  });

  test('保存済みの高さはマウント時にビューポート依存の上限/下限へクランプされる', async () => {
    localStorage.setItem(editorHeightsStorageKey('nb-1'), JSON.stringify({ 'cell-1': -500 }));
    act(() => {
      root.render(<SqlEditor value="SELECT 1" notebookId="nb-1" cellId="cell-1" />);
    });
    await waitForReady(container);

    expect(editorHost(container).style.height).toBe(`${EDITOR_HEIGHT_MIN}px`);
  });

  test('pointercancelでドラッグが終了し、bodyのcursor/userSelectがリークしない', async () => {
    act(() => {
      root.render(<SqlEditor value="SELECT 1" notebookId="nb-1" cellId="cell-1" />);
    });
    await waitForReady(container);

    const handle = heightHandle(container);
    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, pointerId: 9 })));
    expect(document.body.style.cursor).toBe('row-resize');

    act(() => window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 9 })));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  // codex 再レビュー指摘: 手動オーバーライドの上限は仕様どおり常にビューポート高さの
  // 80%（EDITOR_AUTO_HEIGHT_MAXによる底上げはしない）。その代わり、自動伸縮側
  // （SqlEditor の syncHeight）が editorHeightMax(window.innerHeight) と min() を取ることで、
  // 40行分の自動伸縮（行数だけなら816px相当）でも実際の描画高さは768px高の画面の
  // 80%相当（614px）にクランプされる。これにより aria-valuenow は常に aria-valuemax
  // 以下になり、自動→手動の移行（矢印キー1回や移動量ゼロのドラッグ）でも
  // 高さが不連続にジャンプしない。
  describe('40行分自動伸縮した状態（768px高のビューポート）でのARIA範囲と連続性', () => {
    test('自動伸縮の高さはeditorHeightMax(768)=614pxへクランプされ、aria-valuenow<=aria-valuemaxになる', async () => {
      expect(window.innerHeight).toBe(768);
      const expectedAutoHeight = editorHeightMax(768);
      mockLoadMonacoWithLineCount(41); // MAX_LINES(40)相当(816px)になるはずだが614pxへクランプされる
      act(() => {
        root.render(<SqlEditor value={'\n'.repeat(41)} notebookId="nb-1" cellId="cell-1" />);
      });
      await waitForReady(container);

      const handle = heightHandle(container);
      expect(handle.getAttribute('aria-valuenow')).toBe(String(expectedAutoHeight));
      expect(handle.getAttribute('aria-valuemax')).toBe(String(expectedAutoHeight));
      expect(editorHost(container).style.height).toBe(`${expectedAutoHeight}px`);
    });

    test('移動量ゼロのドラッグでは高さが完全に不変', async () => {
      const expectedAutoHeight = editorHeightMax(768);
      mockLoadMonacoWithLineCount(41);
      act(() => {
        root.render(<SqlEditor value={'\n'.repeat(41)} notebookId="nb-1" cellId="cell-1" />);
      });
      await waitForReady(container);

      const handle = heightHandle(container);
      act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, pointerId: 1 })));
      // clientYが変化しない（移動量ゼロ）のpointermove。
      act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 300, pointerId: 1 })));
      act(() => window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 })));

      expect(editorHost(container).style.height).toBe(`${expectedAutoHeight}px`);
    });

    test('最初のArrowUp操作は現在の高さから正確に16px減る', async () => {
      const expectedAutoHeight = editorHeightMax(768);
      mockLoadMonacoWithLineCount(41);
      act(() => {
        root.render(<SqlEditor value={'\n'.repeat(41)} notebookId="nb-1" cellId="cell-1" />);
      });
      await waitForReady(container);

      const handle = heightHandle(container);
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      });
      act(() => handle.dispatchEvent(event));

      expect(editorHost(container).style.height).toBe(`${expectedAutoHeight - 16}px`);
      expect(handle.getAttribute('aria-valuenow')).toBe(String(expectedAutoHeight - 16));
    });
  });
});

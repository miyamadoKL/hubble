import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadMonaco } from './monacoLoader';
import { useEditorRuntime } from './EditorRuntime';
import { useUiStore } from '../stores/uiStore';
import {
  attachDiagnostics,
  registerTrinoLanguage,
  TRINO_LANGUAGE_ID,
  TRINO_MARKER_OWNER,
} from './registerTrinoLanguage';

vi.mock('./registerTrinoLanguage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registerTrinoLanguage')>();
  return {
    ...actual,
    registerTrinoLanguage: vi.fn(),
    attachDiagnostics: vi.fn(),
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

const disposeDiagnostics = vi.fn();
const setModelLanguage = vi.fn();
const setModelMarkers = vi.fn();

const model = {
  getLineCount: () => 4,
};

// editor.addAction に渡される descriptor の、テストで検証したい部分だけを
// 型付けした最小限のインターフェース（Monaco の IActionDescriptor 全体は
// import しない）。
interface ActionDescriptor {
  id: string;
  keybindings?: number[];
  run: (editor: unknown) => unknown;
}

const editor = {
  getModel: () => model,
  getValue: () => 'SELECT 1',
  onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
  onDidContentSizeChange: vi.fn(() => ({ dispose: vi.fn() })),
  dispose: vi.fn(),
  setValue: vi.fn(),
  // addAction は Monaco の実 API に合わせ、キーバインド解除用の disposable を
  // 返す（attachEditorCommands はこれを合成 disposable として呼び出し元へ返す）。
  // デフォルト実装は descriptor を使わないが、呼び出し側で `addAction.mock.calls`
  // から descriptor を型付きで読み取れるよう、vi.fn の型引数だけで型を明示する。
  addAction: vi.fn<(descriptor: ActionDescriptor) => { dispose: () => void }>(() => ({
    dispose: vi.fn(),
  })),
};

// KeyMod/KeyCode の実際の値は attachEditorCommands（実装をモックしていない）が
// addAction 呼び出しに使うため、識別可能な適当な数値を割り当てる。
const monacoNs = {
  editor: {
    create: vi.fn(() => editor),
    setModelLanguage,
    setModelMarkers,
  },
  KeyMod: { CtrlCmd: 2048, Shift: 1024 },
  KeyCode: { Enter: 3, KeyI: 39, KeyF: 36 },
};

let isTrinoRuntime = true;

function runtime(): ReturnType<typeof useEditorRuntime> {
  return {
    cache: {} as ReturnType<typeof useEditorRuntime>['cache'],
    getContext: () => ({}),
    getDatasourceId: () => 'trino-default',
    isTrinoLanguage: () => isTrinoRuntime,
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

function Harness({ trinoLanguage }: { trinoLanguage: boolean }) {
  return <SqlEditor value="SELECT 1" trinoLanguage={trinoLanguage} />;
}

describe('SqlEditor datasource language switch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    isTrinoRuntime = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.mocked(loadMonaco).mockResolvedValue(monacoNs as unknown as typeof import('monaco-editor'));
    vi.mocked(useEditorRuntime).mockImplementation(runtime);
    vi.mocked(useUiStore).mockImplementation(((selector: (s: { theme: string }) => unknown) =>
      selector({ theme: 'dark' })) as typeof useUiStore);

    vi.mocked(registerTrinoLanguage).mockReset();
    vi.mocked(attachDiagnostics).mockReset();
    vi.mocked(attachDiagnostics).mockReturnValue({ dispose: disposeDiagnostics });
    setModelLanguage.mockReset();
    setModelMarkers.mockReset();
    disposeDiagnostics.mockReset();
    monacoNs.editor.create.mockClear();
    editor.addAction.mockClear();
    editor.addAction.mockImplementation(() => ({ dispose: vi.fn() }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('detaches Trino diagnostics when switching away from Trino language', async () => {
    root.render(<Harness trinoLanguage />);
    await waitForReady(container);

    expect(attachDiagnostics).toHaveBeenCalledTimes(1);
    expect(setModelLanguage).toHaveBeenCalledWith(model, TRINO_LANGUAGE_ID);

    act(() => {
      root.render(<Harness trinoLanguage={false} />);
    });
    await flushPromises();

    expect(disposeDiagnostics).toHaveBeenCalledTimes(1);
    expect(setModelMarkers).toHaveBeenCalledWith(model, TRINO_MARKER_OWNER, []);
    expect(setModelLanguage).toHaveBeenLastCalledWith(model, 'sql');
    expect(attachDiagnostics).toHaveBeenCalledTimes(1);
  });

  test('uses the latest controlled value when Monaco resolves after a prop update', async () => {
    const pending = Promise.withResolvers<typeof import('monaco-editor')>();
    let currentValue = '';
    const setValue = vi.fn((next: string) => {
      currentValue = next;
    });
    const delayedEditor = {
      ...editor,
      getValue: () => currentValue,
      setValue,
    };
    const create = vi.fn((_host: HTMLElement, options: { value?: string }) => {
      currentValue = options.value ?? '';
      return delayedEditor;
    });
    const delayedMonaco = {
      editor: {
        create,
        setModelLanguage,
        setModelMarkers,
      },
      KeyMod: monacoNs.KeyMod,
      KeyCode: monacoNs.KeyCode,
    };
    vi.mocked(loadMonaco).mockReturnValue(pending.promise);

    act(() => {
      root.render(<SqlEditor value="initial" trinoLanguage={false} />);
    });
    act(() => {
      root.render(<SqlEditor value="latest" trinoLanguage={false} />);
    });
    expect(create).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(delayedMonaco as unknown as typeof import('monaco-editor'));
      await pending.promise;
    });

    expect(create.mock.calls[0]?.[1].value).toBe('latest');
    expect(currentValue).toBe('latest');
    expect(setValue).not.toHaveBeenCalled();
  });

  // 回帰テスト: Ctrl/Cmd+Enter の実行コマンドは、Trino 診断がまだアタッチされて
  // いなくても（= trinoLanguage が false、またはリロード直後で判定がまだ確定
  // していない一瞬の間でも）Monaco エディターに配線されていなければならない。
  // 修正前はこの配線が attachDiagnostics（trinoLanguage=true のときだけ呼ばれる）
  // の中にあったため、非Trinoデータソースや判定確定前は Ctrl+Enter が完全に
  // 無反応だった。
  test('binds Ctrl/Cmd+Enter execute even when Trino diagnostics are not attached', async () => {
    const onExecute = vi.fn();
    root.render(<SqlEditor value="SELECT 1" trinoLanguage={false} onExecute={onExecute} />);
    await waitForReady(container);

    // Trino 診断はアタッチされていないことを前提として確認する
    // （このテストが本当に「Trino診断とは独立」であることを検証するため）。
    expect(attachDiagnostics).not.toHaveBeenCalled();

    // 実行アクションは format アクションと合わせて addAction で2回登録される。
    expect(editor.addAction).toHaveBeenCalledTimes(2);
    const executeCall = editor.addAction.mock.calls.find(
      ([descriptor]) => descriptor.id === 'fable.executeSql',
    );
    expect(executeCall).toBeDefined();
    const [descriptor] = executeCall!;
    expect(descriptor.keybindings).toEqual([monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.Enter]);

    descriptor.run(editor);
    expect(onExecute).toHaveBeenCalledWith(editor);
  });

  // 回帰テスト（P1）: Monaco の addCommand は動的キーバインド登録を破棄する
  // disposable を返さないため、以前の実装ではエディターのアンマウント/再生成の
  // たびに古いキーバインドが蓄積した。addAction ベースに揃えたことで、
  // attachEditorCommands が返す合成 disposable をエディター破棄時に dispose すれば
  // 実行/整形の両アクションが確実に解除されることを検証する。
  test('disposes the execute and format actions when the editor unmounts', async () => {
    const executeDispose = vi.fn();
    const formatDispose = vi.fn();
    editor.addAction.mockImplementationOnce(() => ({ dispose: executeDispose }));
    editor.addAction.mockImplementationOnce(() => ({ dispose: formatDispose }));

    root.render(<Harness trinoLanguage={false} />);
    await waitForReady(container);
    expect(editor.addAction).toHaveBeenCalledTimes(2);
    expect(executeDispose).not.toHaveBeenCalled();
    expect(formatDispose).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });

    expect(executeDispose).toHaveBeenCalledTimes(1);
    expect(formatDispose).toHaveBeenCalledTimes(1);
  });

  // 回帰テスト（P1）: アンマウント後に同じセルを再マウントしても、直前の
  // インスタンスの登録が残らず、新しいインスタンスの実行/整形アクションが
  // ちょうど1組だけ有効な状態になることを検証する（disposeを怠ると新旧の
  // ハンドラーが両方生き残り、Ctrl+Enterで実行が二重に走るなどの不具合になる）。
  test('registers exactly one fresh set of actions after unmount + remount', async () => {
    root.render(<Harness trinoLanguage={false} />);
    await waitForReady(container);
    expect(editor.addAction).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });

    editor.addAction.mockClear();
    root = createRoot(container);
    root.render(<Harness trinoLanguage={false} />);
    await waitForReady(container);

    // 直前のインスタンス分は蓄積されず、新しいインスタンスの2件だけが登録される。
    expect(editor.addAction).toHaveBeenCalledTimes(2);
  });
});

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
    setModelLanguage,
    setModelMarkers,
  },
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
});

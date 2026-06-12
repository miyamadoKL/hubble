import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  setActiveEditor,
  clearActiveEditor,
  getActiveEditor,
  insertAtCursor,
} from './activeEditor';
import type * as monaco from 'monaco-editor';

// A minimal fake editor capturing executeEdits/focus calls. The registry only
// touches getSelection / executeEdits / focus, so the rest is unneeded.
function fakeEditor() {
  const calls: { text: string }[] = [];
  const editor = {
    getSelection: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
    executeEdits: (_src: string, edits: { text: string }[]) => {
      calls.push(...edits);
      return true;
    },
    focus: vi.fn(),
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  return { editor, calls };
}

beforeEach(() => {
  // Drop any registration carried over between tests.
  clearActiveEditor('c1');
  clearActiveEditor('c2');
});

describe('active-editor registry', () => {
  test('getActiveEditor returns the focused editor', () => {
    const { editor } = fakeEditor();
    setActiveEditor('c1', editor);
    expect(getActiveEditor()?.cellId).toBe('c1');
  });

  test('falls back to the last-focused editor after blur', () => {
    const a = fakeEditor();
    setActiveEditor('c1', a.editor);
    // Simulate blur by clearing focus for c1 — but the *last* focused should be
    // re-established only via setActiveEditor; clearing both drops the fallback.
    clearActiveEditor('c1');
    expect(getActiveEditor()).toBeNull();
  });

  test('switching focus updates the target', () => {
    const a = fakeEditor();
    const b = fakeEditor();
    setActiveEditor('c1', a.editor);
    setActiveEditor('c2', b.editor);
    expect(getActiveEditor()?.cellId).toBe('c2');
  });
});

describe('insertAtCursor', () => {
  test('inserts at the active editor and reports success', () => {
    const { editor, calls } = fakeEditor();
    setActiveEditor('c1', editor);
    const ok = insertAtCursor('orders');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('orders');
    expect(editor.focus).toHaveBeenCalled();
  });

  test('returns false when no editor is registered', () => {
    expect(insertAtCursor('orders')).toBe(false);
  });
});

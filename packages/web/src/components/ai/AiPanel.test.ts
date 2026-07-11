// AI提案の適用先追跡、編集競合とundo後の再適用を検証する。
import { describe, expect, it, vi } from 'vitest';
import type * as monaco from 'monaco-editor';
import { applyCapturedSql, type CapturedTarget } from './AiPanel';

const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 9 };

function makeTarget(options: { text?: string; uri?: string; trackedRange?: monaco.IRange } = {}) {
  let currentText = options.text ?? 'SELECT 1';
  let currentRange = options.trackedRange ?? range;
  const model = {
    uri: { toString: () => options.uri ?? 'inmemory://cell/1' },
    getValueInRange: () => currentText,
    getOffsetAt: (position: { column: number }) => position.column - 1,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
  };
  const editor = {
    getModel: () => model,
    executeEdits: vi.fn((_source: string, edits: { text: string }[]) => {
      currentText = edits[0]!.text;
    }),
    focus: vi.fn(),
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  const tracking = {
    getRange: () => currentRange,
    set: vi.fn((decorations: { range: monaco.IRange }[]) => {
      currentRange = decorations[0]!.range;
    }),
    clear: vi.fn(),
  } as unknown as monaco.editor.IEditorDecorationsCollection;
  const target: CapturedTarget = {
    cellId: 'cell-1',
    editor,
    range,
    original: 'SELECT 1',
    modelUri: 'inmemory://cell/1',
    tracking,
  };
  return {
    target,
    editor,
    tracking,
    setText: (text: string) => {
      currentText = text;
    },
  };
}

describe('applyCapturedSql', () => {
  it('対象が変わっていなければ提案を適用する', () => {
    const { target, editor, tracking } = makeTarget();

    expect(applyCapturedSql(target, 'SELECT 2')).toBe(true);
    expect(editor.executeEdits).toHaveBeenCalledOnce();
    expect(tracking.set).toHaveBeenCalledOnce();
    expect(tracking.clear).not.toHaveBeenCalled();
  });

  it('無関係な編集でversionが進んでも追跡範囲が同じなら適用する', () => {
    const shiftedRange = { ...range, startLineNumber: 2, endLineNumber: 2 };
    const { target, editor } = makeTarget({ trackedRange: shiftedRange });

    expect(applyCapturedSql(target, 'SELECT 2')).toBe(true);
    expect(editor.executeEdits).toHaveBeenCalledWith(
      'ai-assistant-apply',
      expect.arrayContaining([expect.objectContaining({ range: shiftedRange })]),
    );
  });

  it('対象文字列またはmodelが変わった場合は適用しない', () => {
    const changedText = makeTarget({ text: 'SELECT 9' });
    const changedModel = makeTarget({ uri: 'inmemory://cell/2' });

    expect(applyCapturedSql(changedText.target, 'SELECT 2')).toBe(false);
    expect(applyCapturedSql(changedModel.target, 'SELECT 2')).toBe(false);
    expect(changedText.tracking.clear).not.toHaveBeenCalled();
    expect(changedModel.tracking.clear).not.toHaveBeenCalled();
  });

  it('対象内編集をundoすれば再試行できる', () => {
    const target = makeTarget();
    target.setText('SELECT 9');
    expect(applyCapturedSql(target.target, 'SELECT 2')).toBe(false);

    target.setText('SELECT 1');
    expect(applyCapturedSql(target.target, 'SELECT 2')).toBe(true);
    expect(target.tracking.clear).not.toHaveBeenCalled();
  });

  it('適用後にundoすれば同じ提案を再適用できる', () => {
    const target = makeTarget();
    expect(applyCapturedSql(target.target, 'SELECT 2')).toBe(true);

    target.setText('SELECT 1');
    expect(applyCapturedSql(target.target, 'SELECT 2')).toBe(true);
    expect(target.editor.executeEdits).toHaveBeenCalledTimes(2);
    expect(target.tracking.set).toHaveBeenCalledTimes(2);
  });
});

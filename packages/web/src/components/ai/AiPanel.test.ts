// @vitest-environment jsdom
// AI提案の適用先追跡、編集競合とundo後の再適用を検証する。
// request世代とresize資源の解放も検証対象に含める。
import { describe, expect, it, vi } from 'vitest';
import type * as monaco from 'monaco-editor';
import {
  AiRequestCoordinator,
  applyCapturedSql,
  beginPanelResize,
  taskLabelKey,
  type CapturedTarget,
} from './AiPanel';
import { t } from '../../i18n/t';
import { aiMessages } from '../../i18n/messages/ai';

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

describe('taskLabelKey', () => {
  // レビュー指摘: 応答エリアの直前タスク表示 (lastTask) が契約値
  // (explain/fix/draft/rewrite) をそのまま生表示していた。taskLabelKey() が
  // 各タスクを正しい辞書キーへ変換し、ja ロケールで翻訳済みラベルになることを固定する。
  it('契約値ごとの辞書キーを返し、ja ロケールで翻訳済みラベルになる', () => {
    expect(t(aiMessages, taskLabelKey('explain'), 'ja')).toBe('説明');
    expect(t(aiMessages, taskLabelKey('fix'), 'ja')).toBe('エラー修正');
    expect(t(aiMessages, taskLabelKey('draft'), 'ja')).toBe('下書き');
    expect(t(aiMessages, taskLabelKey('rewrite'), 'ja')).toBe('書き換え');
  });
});

describe('AiRequestCoordinator', () => {
  it('metadata待機中を含め同時に一つのrequestだけを許可する', () => {
    const coordinator = new AiRequestCoordinator();
    const first = coordinator.claim();

    expect(first).not.toBeNull();
    expect(coordinator.claim()).toBeNull();
    expect(coordinator.isCurrent(first!)).toBe(true);
  });

  it('完了した世代のcallbackを拒否し、新しい世代だけをcurrentにする', () => {
    const coordinator = new AiRequestCoordinator();
    const first = coordinator.claim()!;
    expect(coordinator.finish(first)).toBe(true);
    const second = coordinator.claim()!;

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });

  it('disposeですべてのrequestを中断し、世代を無効化する', () => {
    const coordinator = new AiRequestCoordinator();
    const claim = coordinator.claim()!;

    coordinator.dispose();

    expect(claim.controller.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(claim)).toBe(false);
  });

  it('Stopはrequestを同期的に中断して次の世代を許可する', () => {
    const coordinator = new AiRequestCoordinator();
    const claim = coordinator.claim()!;

    expect(coordinator.abortCurrent()).toBe(true);

    expect(claim.controller.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(claim)).toBe(false);
    expect(coordinator.claim()).not.toBeNull();
  });
});

describe('beginPanelResize', () => {
  it('cleanupでlistenerを外しbody styleを元に戻す', () => {
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
    const setWidth = vi.fn();
    const cleanup = beginPanelResize(500, 300, setWidth);
    const move = new Event('pointermove') as PointerEvent;
    Object.defineProperty(move, 'clientX', { value: 450 });

    window.dispatchEvent(move);
    expect(setWidth).toHaveBeenCalledWith(350);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    cleanup();
    window.dispatchEvent(move);
    expect(setWidth).toHaveBeenCalledOnce();
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
  });
});

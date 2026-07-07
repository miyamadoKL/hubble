/**
 * AiDiffApply.tsx
 *
 * AI アシスタントが提案した SQL を、適用前にユーザーが確認するための diff モーダル。
 * 左に現在の SQL、右に提案 SQL を Monaco の diff エディターで並べ、Apply ボタンで
 * 初めて呼び出し元へ適用が通知される。AI がエディターを直接書き換える経路を
 * 作らないための確認ゲートであり、適用自体は呼び出し元（AiPanel）が
 * `executeEdits` 経由で行うため undo も効く。
 */
import { useEffect, useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { loadMonaco } from '../../editor/monacoLoader';
import { applyFableTheme } from '../../editor/theme';
import { useUiStore } from '../../stores/uiStore';

/** AiDiffApply コンポーネントの props。 */
export interface AiDiffApplyProps {
  /** モーダルの表示/非表示。 */
  open: boolean;
  /** 現在の SQL（diff の左側）。 */
  original: string;
  /** AI が提案した SQL（diff の右側）。 */
  proposed: string;
  /** ユーザーが Apply を押したときに呼ばれる（引数は提案 SQL）。 */
  onApply: (sql: string) => void;
  /** モーダルを閉じるときに呼ばれる。 */
  onClose: () => void;
}

/**
 * 提案 SQL の diff 確認モーダル。open の間だけ Monaco の diff エディターを生成し、
 * 閉じるときに model とエディターを破棄する。
 */
export function AiDiffApply({ open, original, proposed, onApply, onClose }: AiDiffApplyProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const theme = useUiStore((s) => s.theme);

  // open の間だけ diff エディターを生成する。original / proposed が変わったら作り直す。
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let editor: monaco.editor.IStandaloneDiffEditor | undefined;
    let originalModel: monaco.editor.ITextModel | undefined;
    let modifiedModel: monaco.editor.ITextModel | undefined;

    void loadMonaco().then((monacoNs) => {
      if (disposed || !hostRef.current) return;
      applyFableTheme(monacoNs, theme);
      editor = monacoNs.editor.createDiffEditor(hostRef.current, {
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbersMinChars: 3,
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        // diff 確認だけの一時ビューなので折り返して全体を見えやすくする。
        wordWrap: 'on',
      });
      originalModel = monacoNs.editor.createModel(original, 'sql');
      modifiedModel = monacoNs.editor.createModel(proposed, 'sql');
      editor.setModel({ original: originalModel, modified: modifiedModel });
    });

    return () => {
      disposed = true;
      editor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
    // theme はモーダルを開いている間に切り替わることは稀なので、生成時の値だけ使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, original, proposed]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Review proposed SQL"
      description="Apply replaces the target range in the editor. You can undo with Ctrl/Cmd+Z."
      className="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onApply(proposed)}>
            Apply
          </Button>
        </>
      }
    >
      {/* Monaco diff エディターのマウント先。モーダル内で固定高にする。 */}
      <div
        ref={hostRef}
        className="h-80 w-full overflow-hidden rounded-md border border-border-base"
        data-testid="ai-diff-editor"
      />
    </Modal>
  );
}

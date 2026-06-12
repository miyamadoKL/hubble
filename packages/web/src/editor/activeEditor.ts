// Active-editor registry (design.md §5: テーブル/カラムのクリックでカーソル位置に
// 挿入). The Data browser needs to drop text into "the SQL cell the user was last
// editing", but it lives in the sidebar — far from any Monaco instance. Rather
// than thread an editor ref through the tree, each SqlCell registers its editor
// here on focus; the browser reads the current registration and inserts at the
// caret. The registry holds only the *focused* editor (or the most recent one),
// so the target matches user intent.
//
// This module is deliberately framework-free (no React) so non-component code
// (the Data browser handlers) can call it imperatively.

import type * as monaco from 'monaco-editor';

type Editor = monaco.editor.IStandaloneCodeEditor;

interface Registration {
  cellId: string;
  editor: Editor;
}

/** The editor that currently has focus (preferred insert target). */
let focused: Registration | null = null;
/** The last editor that had focus (fallback when nothing is focused now). */
let lastFocused: Registration | null = null;

/** Mark an editor as focused (call from `onDidFocusEditorText`). */
export function setActiveEditor(cellId: string, editor: Editor): void {
  focused = { cellId, editor };
  lastFocused = focused;
}

/** Clear focus for a cell if it owns the current focus (on blur / unmount). */
export function clearActiveEditor(cellId: string): void {
  if (focused?.cellId === cellId) focused = null;
  if (lastFocused?.cellId === cellId) lastFocused = null;
}

/** The best insert target: the focused editor, else the last focused one. */
export function getActiveEditor(): Registration | null {
  return focused ?? lastFocused;
}

/**
 * Insert `text` at the active editor's caret, replacing any selection, then
 * focus it and place the caret after the inserted text. Returns true if an
 * editor was available (so callers can toast otherwise).
 */
export function insertAtCursor(text: string): boolean {
  const reg = getActiveEditor();
  const editor = reg?.editor;
  if (!editor) return false;
  const selection = editor.getSelection();
  if (!selection) return false;
  // `executeEdits` keeps undo history coherent; `setSelection: true` on the op
  // would select the inserted text — instead we collapse the caret after it.
  editor.executeEdits('data-browser-insert', [{ range: selection, text, forceMoveMarkers: true }]);
  editor.focus();
  return true;
}

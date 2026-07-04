// Active-editor registry (テーブル/カラムのクリックでカーソル位置に
// 挿入). The Data browser needs to drop text into "the SQL cell the user was last
// editing", but it lives in the sidebar — far from any Monaco instance. Rather
// than thread an editor ref through the tree, each SqlCell registers its editor
// here on focus; the browser reads the current registration and inserts at the
// caret. The registry holds only the *focused* editor (or the most recent one),
// so the target matches user intent.
//
// This module is deliberately framework-free (no React) so non-component code
// (the Data browser handlers) can call it imperatively.
//
// ---- ファイル概要（日本語） ----
// 「現在アクティブな（あるいは最後にフォーカスされた）SqlEditor」を保持するだけの
// グローバルレジストリ。データブラウザ（サイドバー）でテーブル/カラムをクリックした
// ときに、「ユーザーが最後に編集していた SQL セル」のカーソル位置へテキストを挿入
// したいが、サイドバーから各 Monaco インスタンスへの参照を props で引き回すのは
// 大掛かりになる。そこで各 SqlCell がフォーカス時に自分のエディターをここへ登録し、
// データブラウザ側は「現在の登録」を読んでカーソル位置に挿入する、というシンプルな
// 仕組みにしている。React に依存しない（コンポーネント外のハンドラからも呼べる）
// 点が重要。

import type * as monaco from 'monaco-editor';

// このモジュールが扱う Monaco エディターの型エイリアス（スタンドアロンエディター）。
type Editor = monaco.editor.IStandaloneCodeEditor;

// 1 つの登録エントリ：どのセル（cellId）のどのエディターインスタンスか。
interface Registration {
  cellId: string;
  editor: Editor;
}

/** The editor that currently has focus (preferred insert target). */
/** 現在フォーカスを持っているエディター（挿入先として最優先される）。 */
let focused: Registration | null = null;
/** The last editor that had focus (fallback when nothing is focused now). */
/** 直前までフォーカスを持っていたエディター（現在どれもフォーカスされていない場合のフォールバック）。 */
let lastFocused: Registration | null = null;

/**
 * Mark an editor as focused (call from `onDidFocusEditorText`).
 *
 * エディターをフォーカス状態として登録する。Monaco の `onDidFocusEditorText`
 * イベントハンドラから呼び出す想定。`focused` と `lastFocused` を同時に更新する。
 */
export function setActiveEditor(cellId: string, editor: Editor): void {
  focused = { cellId, editor };
  lastFocused = focused;
}

/**
 * Clear focus for a cell if it owns the current focus (on blur / unmount).
 *
 * 指定した cellId が現在の focused / lastFocused の持ち主であれば、それを解除する。
 * blur イベントやコンポーネントのアンマウント時に呼ぶ。他のセルが持ち主の場合は
 * 何もしない（意図しない登録の上書き解除を防ぐため）。
 */
export function clearActiveEditor(cellId: string): void {
  if (focused?.cellId === cellId) focused = null;
  if (lastFocused?.cellId === cellId) lastFocused = null;
}

/**
 * The best insert target: the focused editor, else the last focused one.
 *
 * 挿入先として最も適切なエディターを返す。フォーカス中のものがあればそれを、
 * なければ直近にフォーカスされていたものを返す。どちらもなければ null。
 */
export function getActiveEditor(): Registration | null {
  return focused ?? lastFocused;
}

/**
 * Insert `text` at the active editor's caret, replacing any selection, then
 * focus it and place the caret after the inserted text. Returns true if an
 * editor was available (so callers can toast otherwise).
 *
 * アクティブなエディターのカーソル位置（選択範囲があればそれを置き換えて）に
 * `text` を挿入し、フォーカスを当てた上でカーソルを挿入したテキストの直後に移動する。
 * 対象となるエディターが存在しない場合は false を返すので、呼び出し側はトースト
 * 通知などでユーザーにフィードバックできる。
 */
export function insertAtCursor(text: string): boolean {
  const reg = getActiveEditor();
  const editor = reg?.editor;
  if (!editor) return false;
  const selection = editor.getSelection();
  if (!selection) return false;
  // `executeEdits` keeps undo history coherent; `setSelection: true` on the op
  // would select the inserted text — instead we collapse the caret after it.
  // `executeEdits` を使うことで undo 履歴の整合性を保つ。edit オプションで
  // `setSelection: true` にすると挿入したテキストが選択状態になってしまうため、
  // 代わりに `forceMoveMarkers: true` でカーソルを挿入テキストの直後に収束させる。
  editor.executeEdits('data-browser-insert', [{ range: selection, text, forceMoveMarkers: true }]);
  editor.focus();
  return true;
}

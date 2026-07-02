// SQL formatting via sql-formatter (Trino dialect). design.md §5/§8: format the
// selection if there is one, otherwise the whole document; wire as a Monaco
// action + Ctrl/Cmd+I. Kept separate so it can be unit-tested without an editor.
//
// ---- ファイル概要（日本語） ----
// sql-formatter（Trino 方言）を使った SQL 整形機能を提供するモジュール。design.md
// §5/§8 に従い、選択範囲があればその部分だけを、なければドキュメント全体を整形する。
// Monaco のアクション（コマンドパレット/右クリックメニュー/Ctrl+I や Cmd+I ショートカット）
// として registerTrinoLanguage.ts から配線される。Monaco エディターに依存しない
// `formatSql` を分離してあるため、エディターなしでも単体テストできる。

import { format } from 'sql-formatter';
import type * as monaco from 'monaco-editor';

// sql-formatter に渡す整形オプション。Trino 方言、インデント幅 2、キーワード大文字化、
// 複数クエリ間に空行 1 行、という Fable の SQL 整形スタイルを固定で指定する。
const FORMAT_OPTIONS = {
  language: 'trino',
  tabWidth: 2,
  keywordCase: 'upper',
  linesBetweenQueries: 1,
} as const;

/**
 * Format a SQL string with the Trino dialect. Returns input unchanged on error.
 *
 * SQL 文字列を Trino 方言で整形する。sql-formatter が構文を解釈できず例外を
 * 投げた場合は、整形前の文字列をそのまま返す（ユーザーの入力を壊さないため）。
 */
export function formatSql(sql: string): string {
  try {
    return format(sql, FORMAT_OPTIONS);
  } catch {
    return sql;
  }
}

/**
 * Format the editor's current selection (if non-empty) or the whole document,
 * applying the result as an undoable edit. Exported for the action handler.
 *
 * エディターの現在の選択範囲（空でなければ）、またはドキュメント全体を整形し、
 * undo 可能な編集として適用する。Monaco のアクションハンドラから呼ばれる想定で
 * export されている。
 */
export function formatEditor(editor: monaco.editor.ICodeEditor): void {
  const model = editor.getModel();
  if (!model) return;
  const selection = editor.getSelection();

  // 選択範囲がある場合は選択範囲だけを整形して置き換える。
  if (selection && !selection.isEmpty()) {
    const original = model.getValueInRange(selection);
    const formatted = formatSql(original);
    // 整形結果が元と同じなら無駄な編集操作（undo スタックの汚染）を避ける。
    if (formatted !== original) {
      editor.executeEdits('fable-format-selection', [
        { range: selection, text: formatted, forceMoveMarkers: true },
      ]);
    }
    return;
  }

  // 選択範囲がない場合はドキュメント全体を整形して置き換える。
  const original = model.getValue();
  const formatted = formatSql(original);
  if (formatted !== original) {
    editor.executeEdits('fable-format-document', [
      { range: model.getFullModelRange(), text: formatted, forceMoveMarkers: true },
    ]);
  }
}

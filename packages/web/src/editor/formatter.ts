// SQL formatting via sql-formatter (Trino dialect). design.md §5/§8: format the
// selection if there is one, otherwise the whole document; wire as a Monaco
// action + Ctrl/Cmd+I. Kept separate so it can be unit-tested without an editor.

import { format } from 'sql-formatter';
import type * as monaco from 'monaco-editor';

const FORMAT_OPTIONS = {
  language: 'trino',
  tabWidth: 2,
  keywordCase: 'upper',
  linesBetweenQueries: 1,
} as const;

/** Format a SQL string with the Trino dialect. Returns input unchanged on error. */
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
 */
export function formatEditor(editor: monaco.editor.ICodeEditor): void {
  const model = editor.getModel();
  if (!model) return;
  const selection = editor.getSelection();

  if (selection && !selection.isEmpty()) {
    const original = model.getValueInRange(selection);
    const formatted = formatSql(original);
    if (formatted !== original) {
      editor.executeEdits('fable-format-selection', [
        { range: selection, text: formatted, forceMoveMarkers: true },
      ]);
    }
    return;
  }

  const original = model.getValue();
  const formatted = formatSql(original);
  if (formatted !== original) {
    editor.executeEdits('fable-format-document', [
      { range: model.getFullModelRange(), text: formatted, forceMoveMarkers: true },
    ]);
  }
}

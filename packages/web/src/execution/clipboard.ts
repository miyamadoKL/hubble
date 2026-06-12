// Copy result rows to the clipboard as both TSV (text/plain) and an HTML table
// (text/html), so pasting into a spreadsheet keeps the grid (design.md §6:
// クリップボードコピー TSV + HTML の ClipboardItem). Operates over the rows
// currently loaded client-side.

import type { QueryColumn } from '@hubble/contracts';
import type { ResultRow } from './executionStore';

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeTsv(text: string): string {
  // Tabs/newlines would break TSV cell boundaries; neutralise to spaces.
  return text.replace(/[\t\r\n]+/g, ' ');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildTsv(columns: QueryColumn[], rows: ReadonlyArray<ResultRow>): string {
  const header = columns.map((c) => escapeTsv(c.name)).join('\t');
  const body = rows
    .map((row) => columns.map((_, i) => escapeTsv(cellToText(row[i]))).join('\t'))
    .join('\n');
  return body ? `${header}\n${body}` : header;
}

export function buildHtml(columns: QueryColumn[], rows: ReadonlyArray<ResultRow>): string {
  const thead = `<tr>${columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join('')}</tr>`;
  const tbody = rows
    .map(
      (row) =>
        `<tr>${columns.map((_, i) => `<td>${escapeHtml(cellToText(row[i]))}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

/**
 * Write the result to the clipboard as TSV + HTML. Falls back to plain-text TSV
 * when `ClipboardItem` is unavailable (older browsers / insecure contexts).
 */
export async function copyResultToClipboard(
  columns: QueryColumn[],
  rows: ReadonlyArray<ResultRow>,
): Promise<void> {
  const tsv = buildTsv(columns, rows);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const html = buildHtml(columns, rows);
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(tsv);
}

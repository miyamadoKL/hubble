// Copy result rows to the clipboard as both TSV (text/plain) and an HTML table
// (text/html), so pasting into a spreadsheet keeps the grid (design.md §6:
// クリップボードコピー TSV + HTML の ClipboardItem). Operates over the rows
// currently loaded client-side.
//
// ==== ファイルの責務（日本語） ================================================
// 結果グリッドの行をクリップボードへコピーするためのヘルパー群。
// TSV（text/plain）と HTML テーブル（text/html）の両方を同時に書き込むことで、
// スプレッドシートに貼り付けたときに表の形（罫線とセル区切り）が保たれる
// ようにしている（design.md §6）。対象はすでにクライアント側に読み込み済みの
// 行のみで、サーバーへの追加取得は行わない。
// ============================================================================

import type { QueryColumn } from '@hubble/contracts';
import type { ResultRow } from './executionStore';

// セルの値（JSON スカラーまたは null/undefined）を表示用文字列に変換する。
// オブジェクト/配列は JSON 文字列化して埋め込む。
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeTsv(text: string): string {
  // Tabs/newlines would break TSV cell boundaries; neutralise to spaces.
  // タブ/改行を含む値をそのまま出すと TSV のセル境界が壊れるため、空白に置換する。
  return text.replace(/[\t\r\n]+/g, ' ');
}

// HTML 出力側で構文が壊れないよう、最低限の特殊文字だけをエスケープする。
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 列定義と行データから TSV（タブ区切り）テキストを組み立てる。
 * 1 行目がヘッダー（列名）、以降が各行の値。
 */
export function buildTsv(columns: QueryColumn[], rows: ReadonlyArray<ResultRow>): string {
  const header = columns.map((c) => escapeTsv(c.name)).join('\t');
  const body = rows
    .map((row) => columns.map((_, i) => escapeTsv(cellToText(row[i]))).join('\t'))
    .join('\n');
  return body ? `${header}\n${body}` : header;
}

/**
 * 列定義と行データから HTML の `<table>` 文字列を組み立てる。
 * スプレッドシートへの貼り付け時にセル区切りが保持されるようにするための表現。
 */
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
 * 結果を TSV + HTML の両形式でクリップボードへ書き込む。`ClipboardItem` が
 * 使えない環境（古いブラウザや非セキュアコンテキストなど）では、プレーン
 * テキストの TSV のみを書き込むフォールバックにする。
 */
export async function copyResultToClipboard(
  columns: QueryColumn[],
  rows: ReadonlyArray<ResultRow>,
): Promise<void> {
  const tsv = buildTsv(columns, rows);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    // ClipboardItem が使える環境: TSV と HTML の両方を1つのアイテムとして書き込む。
    // 貼り付け先が対応するMIMEタイプを選んでくれる（スプレッドシートは HTML を優先）。
    const html = buildHtml(columns, rows);
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return;
  }
  // フォールバック: プレーンテキストの TSV のみを書き込む。
  await navigator.clipboard.writeText(tsv);
}

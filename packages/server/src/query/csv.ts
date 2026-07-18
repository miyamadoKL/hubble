/**
 * QueryResultEvent から RFC 4180 準拠の CSV を生成し、値整形と互換ヘッダーを定義する。
 *
 * 結果イベントの source 選択は resultEvents.ts、HTTP や外部ストレージへの
 * ストリーム出力、圧縮、ZIP、backpressure、後始末は exportStreams.ts が担当する。
 *
 * CSV 専用ライブラリは導入しない。RFC 4180 エスケープ自体は小さく、
 * コード量を占めるのはこのファイルの外にある streaming、再実行判定、cancel
 * であり、それらはライブラリの守備範囲外のため置換しても正味の削減にならない。
 */
import type { QueryResultEvent } from './resultEvents';

/** 再実行が必要だがバッファのみ返す場合に付与するレスポンスヘッダー名。 */
export const CSV_REEXEC_HEADER = 'X-Hubble-Csv-Reexec';
/** 行数上限で結果を切り詰めた場合に付与するレスポンスヘッダー名。 */
export const CSV_TRUNCATED_HEADER = 'X-Hubble-Csv-Truncated';

/** QueryResultEvent を RFC 4180 準拠の CRLF CSV へ変換する。 */
export async function* csvFromEvents(
  events: AsyncGenerator<QueryResultEvent>,
): AsyncGenerator<string> {
  let headerWritten = false;
  for await (const event of events) {
    if (event.type === 'columns') {
      if (event.columns.length > 0)
        yield `${csvRecord(event.columns.map((column) => column.name))}\r\n`;
      headerWritten = true;
      continue;
    }
    if (!headerWritten) headerWritten = true;
    yield `${csvRecord(event.row)}\r\n`;
  }
}

const FORMULA_LEADING_CHARACTER = /^[=+\-@\t\r\n]/;

/**
 * RFC 4180 に従い、カンマ、ダブルクォート、CR、LF のいずれかを含む場合のみ
 * クォートし、内部のダブルクォートは 2 重化してエスケープする。
 */
export function csvField(value: unknown): string {
  const formatted = formatCell(value);
  // 数値型の符号は維持し、文字列型と構造化された値のテキスト表現だけを
  // 表計算ソフトの数式として解釈されないようにする。
  const shouldNeutralize =
    (typeof value === 'string' || (typeof value === 'object' && value !== null)) &&
    FORMULA_LEADING_CHARACTER.test(formatted);
  const s = shouldNeutralize ? `'${formatted}` : formatted;
  if (s === '') return s;
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * null/undefined は空文字、プリミティブ型はそのまま文字列化し、配列や
 * オブジェクト（Trino の MAP、ARRAY、ROW、JSON 型）はコンパクトな JSON
 * 文字列として埋め込む。
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // 配列やオブジェクト（Trino の MAP、ARRAY、ROW、JSON 型）はコンパクトな JSON にする。
  try {
    return JSON.stringify(value);
  } catch {
    // JSON.stringify が失敗するような値（循環参照など）は最終手段として
    // String() にフォールバックする。
    return String(value);
  }
}

/** 1 行分のセル配列を CSV のレコード行（末尾改行なし）に変換する。 */
export function csvRecord(row: readonly unknown[]): string {
  return row.map(csvField).join(',');
}

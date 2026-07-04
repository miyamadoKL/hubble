/**
 * クエリ結果を xlsx へストリーミング変換する。
 *
 * HTTP レスポンスと S3 アップロードの両方で使えるよう、入力は
 * serializer 非依存の `QueryResultEvent`、出力は Node.js Writable にしている。
 */
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { AppError } from '../errors';
import { formatCell } from './csv';
import type { QueryResultEvent } from './resultEvents';

/** Excel ワークシート 1 枚に書き込める最大行数。ヘッダ行を含む。 */
export const XLSX_MAX_ROWS = 1_048_576;
/** ヘッダ行を除いたデータ行の上限。 */
export const XLSX_MAX_DATA_ROWS = XLSX_MAX_ROWS - 1;
/** xlsx レスポンスの Content-Type。 */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** xlsx 書き出しの設定。 */
export interface XlsxWriteOptions {
  /** シート名。 */
  sheetName?: string;
}

/** JS 値を Excel セル値に変換する。 */
export function toXlsxCellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  return formatCell(value);
}

/** 行イベントを xlsx workbook として writable stream へ書き込む。 */
export async function writeXlsx(
  events: AsyncGenerator<QueryResultEvent>,
  output: Writable,
  options: XlsxWriteOptions = {},
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    useSharedStrings: false,
  });
  const worksheet = workbook.addWorksheet(options.sheetName ?? 'Results');
  let headerWritten = false;
  let dataRows = 0;

  for await (const event of events) {
    if (event.type === 'columns') {
      if (headerWritten) continue;
      headerWritten = true;
      const header = worksheet.addRow(event.columns.map((column) => column.name));
      header.font = { bold: true };
      header.commit();
      continue;
    }
    if (!headerWritten) {
      headerWritten = true;
      worksheet.addRow([]).commit();
    }
    dataRows += 1;
    if (dataRows > XLSX_MAX_DATA_ROWS) {
      throw new AppError(413, {
        code: 'RESULT_TOO_LARGE',
        message:
          'xlsx export is limited to 1,048,576 worksheet rows. Use CSV export for larger results.',
      });
    }
    worksheet.addRow(event.row.map(toXlsxCellValue)).commit();
  }

  await workbook.commit();
}

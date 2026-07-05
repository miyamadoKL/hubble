import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  toXlsxCellValue,
  writeXlsx,
  writeXlsxWorkbook,
  checkXlsxDataRowLimit,
  XLSX_MAX_DATA_ROWS,
} from './xlsx';
import type { QueryResultEvent } from './resultEvents';

async function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('xlsx export writer', () => {
  it('imports exceljs and writes a streaming workbook', async () => {
    expect(typeof ExcelJS.stream.xlsx.WorkbookWriter).toBe('function');
    const out = new PassThrough();
    const events = (async function* (): AsyncGenerator<QueryResultEvent> {
      yield { type: 'columns', columns: [{ name: 'n', type: 'bigint' }] };
      yield { type: 'row', row: [1] };
    })();

    const [bytes] = await Promise.all([collect(out), writeXlsx(events, out)]);

    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
  });

  it('keeps primitive cell types and stringifies complex values', () => {
    expect(toXlsxCellValue(1)).toBe(1);
    expect(toXlsxCellValue(true)).toBe(true);
    expect(toXlsxCellValue(null)).toBeNull();
    expect(toXlsxCellValue({ a: 1 })).toBe('{"a":1}');
  });

  it('writes multiple worksheets in one workbook', async () => {
    const out = new PassThrough();
    const first = (async function* (): AsyncGenerator<QueryResultEvent> {
      yield { type: 'columns', columns: [{ name: 'a', type: 'bigint' }] };
      yield { type: 'row', row: [1] };
    })();
    const second = (async function* (): AsyncGenerator<QueryResultEvent> {
      yield { type: 'columns', columns: [{ name: 'b', type: 'bigint' }] };
      yield { type: 'row', row: [2] };
      yield { type: 'row', row: [3] };
    })();

    const [bytes] = await Promise.all([
      collect(out),
      writeXlsxWorkbook(
        [
          { name: 'First', events: first },
          { name: 'Second', events: second },
        ],
        out,
      ),
    ]);

    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx.load as unknown as (buffer: Uint8Array) => Promise<void>)(bytes);
    expect(workbook.worksheets).toHaveLength(2);
    expect(workbook.getWorksheet('First')?.getRow(1).getCell(1).value).toBe('a');
    expect(workbook.getWorksheet('First')?.rowCount).toBe(2);
    expect(workbook.getWorksheet('Second')?.rowCount).toBe(3);
  });

  it('enforces row limits per worksheet', () => {
    expect(() => checkXlsxDataRowLimit(XLSX_MAX_DATA_ROWS)).not.toThrow();
    try {
      checkXlsxDataRowLimit(XLSX_MAX_DATA_ROWS + 1);
      expect.fail('expected limit error');
    } catch (err) {
      expect(err).toMatchObject({ status: 413, detail: { code: 'RESULT_TOO_LARGE' } });
    }
  });
});

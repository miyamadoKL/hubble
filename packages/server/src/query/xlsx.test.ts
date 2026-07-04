import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { toXlsxCellValue, writeXlsx } from './xlsx';
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
});

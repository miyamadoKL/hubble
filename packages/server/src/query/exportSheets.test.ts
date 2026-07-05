import { describe, expect, it, vi } from 'vitest';
import { SheetsExporter, type SheetsApiClient } from './exportSheets';
import type { QueryResultEvent } from './resultEvents';

function events(rows: number): AsyncGenerator<QueryResultEvent> {
  return (async function* () {
    yield {
      type: 'columns',
      columns: [
        { name: 'id', type: 'bigint' },
        { name: 'name', type: 'varchar' },
      ],
    };
    for (let i = 0; i < rows; i += 1) {
      yield { type: 'row', row: [i, `row-${i}`] };
    }
  })();
}

describe('SheetsExporter', () => {
  it('chunks values and shares the spreadsheet with the principal email', async () => {
    const appendValues = vi.fn<SheetsApiClient['appendValues']>(async () => undefined);
    const shareWithWriter = vi.fn<SheetsApiClient['shareWithWriter']>(async () => undefined);
    const client: SheetsApiClient = {
      createSpreadsheet: async () => ({
        spreadsheetId: 'sheet_1',
        url: 'https://docs.google.com/spreadsheets/d/sheet_1',
      }),
      appendValues,
      renameFirstSheet: async () => undefined,
      addSheet: async () => undefined,
      shareWithWriter,
    };
    const exporter = new SheetsExporter(
      { credentialsFile: '/secure/key.json' },
      async () => client,
    );

    const result = await exporter.export({
      title: 'Hubble qry_1',
      email: 'alice@example.com',
      events: events(10_001),
    });

    expect(result.spreadsheetId).toBe('sheet_1');
    expect(appendValues).toHaveBeenCalledTimes(2);
    const firstValues = appendValues.mock.calls[0]?.[1] as unknown[][] | undefined;
    expect(firstValues?.[0]).toEqual(['id', 'name']);
    expect(shareWithWriter).toHaveBeenCalledWith('sheet_1', 'alice@example.com');
  });

  it('exports multiple sheets and enforces workbook cell limits', async () => {
    const appendValues = vi.fn<SheetsApiClient['appendValues']>(async () => undefined);
    const renameFirstSheet = vi.fn<SheetsApiClient['renameFirstSheet']>(async () => undefined);
    const addSheet = vi.fn<SheetsApiClient['addSheet']>(async () => undefined);
    const shareWithWriter = vi.fn<SheetsApiClient['shareWithWriter']>(async () => undefined);
    const client: SheetsApiClient = {
      createSpreadsheet: async () => ({
        spreadsheetId: 'sheet_multi',
        url: 'https://docs.google.com/spreadsheets/d/sheet_multi',
      }),
      appendValues,
      renameFirstSheet,
      addSheet,
      shareWithWriter,
    };
    const exporter = new SheetsExporter(
      { credentialsFile: '/secure/key.json' },
      async () => client,
    );

    const first = events(1);
    const second = events(1);
    const result = await exporter.exportMultiSheet({
      title: 'Hubble workflow',
      email: 'alice@example.com',
      sheets: [
        { name: 'Step One', events: first },
        { name: 'Step Two', events: second },
      ],
    });

    expect(result.spreadsheetId).toBe('sheet_multi');
    expect(renameFirstSheet).toHaveBeenCalledWith('sheet_multi', 'Step One');
    expect(addSheet).toHaveBeenCalledWith('sheet_multi', 'Step Two');
    expect(appendValues).toHaveBeenCalledTimes(2);
    expect(appendValues.mock.calls[0]?.[2]).toBe("'Step One'!A1");
    expect(appendValues.mock.calls[1]?.[2]).toBe("'Step Two'!A1");
    expect(shareWithWriter).toHaveBeenCalledTimes(1);

    const huge = (async function* (): AsyncGenerator<QueryResultEvent> {
      yield {
        type: 'columns',
        columns: Array.from({ length: 5000 }, (_, i) => ({ name: `c${i}`, type: 'varchar' })),
      };
      for (let i = 0; i < 2000; i += 1) {
        yield { type: 'row', row: Array.from({ length: 5000 }, () => 'x') };
      }
    })();
    await expect(
      exporter.exportMultiSheet({
        title: 'Too big',
        email: 'alice@example.com',
        sheets: [{ name: 'Huge', events: huge }],
      }),
    ).rejects.toMatchObject({ status: 413, detail: { code: 'RESULT_TOO_LARGE' } });
  });

  it('imports googleapis without connecting to Google APIs', async () => {
    const { google } = await import('googleapis');
    expect(typeof google.sheets).toBe('function');
    expect(typeof google.drive).toBe('function');
    expect(typeof google.auth.GoogleAuth).toBe('function');
  });
});

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

  it('imports googleapis without connecting to Google APIs', async () => {
    const { google } = await import('googleapis');
    expect(typeof google.sheets).toBe('function');
    expect(typeof google.drive).toBe('function');
    expect(typeof google.auth.GoogleAuth).toBe('function');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { defaultSheetsClientFactory, SheetsExporter, type SheetsApiClient } from './exportSheets';
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
    const deleteSpreadsheet = vi.fn<NonNullable<SheetsApiClient['deleteSpreadsheet']>>(
      async () => undefined,
    );
    const client: SheetsApiClient = {
      createSpreadsheet: async () => ({
        spreadsheetId: 'sheet_1',
        url: 'https://docs.google.com/spreadsheets/d/sheet_1',
      }),
      appendValues,
      renameFirstSheet: async () => undefined,
      addSheet: async () => undefined,
      shareWithWriter,
      deleteSpreadsheet,
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
    expect(deleteSpreadsheet).not.toHaveBeenCalled();
  });

  it('exports multiple sheets and enforces workbook cell limits', async () => {
    const appendValues = vi.fn<SheetsApiClient['appendValues']>(async () => undefined);
    const renameFirstSheet = vi.fn<SheetsApiClient['renameFirstSheet']>(async () => undefined);
    const addSheet = vi.fn<SheetsApiClient['addSheet']>(async () => undefined);
    const shareWithWriter = vi.fn<SheetsApiClient['shareWithWriter']>(async () => undefined);
    const deleteSpreadsheet = vi.fn<NonNullable<SheetsApiClient['deleteSpreadsheet']>>(
      async () => undefined,
    );
    const client: SheetsApiClient = {
      createSpreadsheet: async () => ({
        spreadsheetId: 'sheet_multi',
        url: 'https://docs.google.com/spreadsheets/d/sheet_multi',
      }),
      appendValues,
      renameFirstSheet,
      addSheet,
      shareWithWriter,
      deleteSpreadsheet,
    };
    const exporter = new SheetsExporter(
      { credentialsFile: '/secure/key.json' },
      async () => client,
    );

    let firstConsumed = false;
    const first = vi.fn(() =>
      (async function* (): AsyncGenerator<QueryResultEvent> {
        for await (const event of events(1)) yield event;
        firstConsumed = true;
      })(),
    );
    const second = vi.fn(() => {
      expect(firstConsumed).toBe(true);
      return events(1);
    });
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
    expect(deleteSpreadsheet).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

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
    expect(deleteSpreadsheet).toHaveBeenCalledWith('sheet_multi');
  });

  it('deletes the created spreadsheet when appending fails and rethrows the original error', async () => {
    const original = new Error('append failed');
    const deleteSpreadsheet = vi.fn<NonNullable<SheetsApiClient['deleteSpreadsheet']>>(
      async () => undefined,
    );
    const client: SheetsApiClient = {
      createSpreadsheet: async () => ({
        spreadsheetId: 'sheet_append_failure',
        url: 'https://docs.google.com/spreadsheets/d/sheet_append_failure',
      }),
      appendValues: async () => {
        throw original;
      },
      renameFirstSheet: async () => undefined,
      addSheet: async () => undefined,
      shareWithWriter: async () => undefined,
      deleteSpreadsheet,
    };
    const exporter = new SheetsExporter(
      { credentialsFile: '/secure/key.json' },
      async () => client,
    );

    await expect(
      exporter.export({
        title: 'Append failure',
        email: 'alice@example.com',
        events: events(1),
      }),
    ).rejects.toBe(original);
    expect(deleteSpreadsheet).toHaveBeenCalledOnce();
    expect(deleteSpreadsheet).toHaveBeenCalledWith('sheet_append_failure');
  });

  it('preserves a sharing error when orphan deletion also fails', async () => {
    const original = new Error('sharing failed');
    const deleteSpreadsheet = vi.fn<NonNullable<SheetsApiClient['deleteSpreadsheet']>>(async () => {
      throw new Error('deletion failed');
    });
    const client: SheetsApiClient = {
      createSpreadsheet: async () => ({
        spreadsheetId: 'sheet_share_failure',
        url: 'https://docs.google.com/spreadsheets/d/sheet_share_failure',
      }),
      appendValues: async () => undefined,
      renameFirstSheet: async () => undefined,
      addSheet: async () => undefined,
      shareWithWriter: async () => {
        throw original;
      },
      deleteSpreadsheet,
    };
    const exporter = new SheetsExporter(
      { credentialsFile: '/secure/key.json' },
      async () => client,
    );

    await expect(
      exporter.export({
        title: 'Share failure',
        email: 'alice@example.com',
        events: events(1),
      }),
    ).rejects.toBe(original);
    expect(deleteSpreadsheet).toHaveBeenCalledWith('sheet_share_failure');
  });

  it('deletes the created spreadsheet when a multi-sheet operation fails', async () => {
    const original = new Error('add sheet failed');
    const deleteSpreadsheet = vi.fn<NonNullable<SheetsApiClient['deleteSpreadsheet']>>(
      async () => undefined,
    );
    const client: SheetsApiClient = {
      createSpreadsheet: async () => ({
        spreadsheetId: 'sheet_multi_failure',
        url: 'https://docs.google.com/spreadsheets/d/sheet_multi_failure',
      }),
      appendValues: async () => undefined,
      renameFirstSheet: async () => undefined,
      addSheet: async () => {
        throw original;
      },
      shareWithWriter: async () => undefined,
      deleteSpreadsheet,
    };
    const exporter = new SheetsExporter(
      { credentialsFile: '/secure/key.json' },
      async () => client,
    );

    await expect(
      exporter.exportMultiSheet({
        title: 'Multi failure',
        email: 'alice@example.com',
        sheets: [
          { name: 'First', events: events(1) },
          { name: 'Second', events: events(1) },
        ],
      }),
    ).rejects.toBe(original);
    expect(deleteSpreadsheet).toHaveBeenCalledWith('sheet_multi_failure');
  });

  it('個別 package から認証と API client をネットワーク接続なしで構築する', async () => {
    const [sheetsApi, driveApi] = await Promise.all([
      import('@googleapis/sheets'),
      import('@googleapis/drive'),
    ]);
    const googleAuth = new sheetsApi.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ],
    });
    const sheets = sheetsApi.sheets({ version: 'v4', auth: googleAuth });
    const drive = driveApi.drive({ version: 'v3', auth: googleAuth });

    expect(googleAuth).toBeInstanceOf(sheetsApi.auth.GoogleAuth);
    expect(typeof sheets.spreadsheets.create).toBe('function');
    expect(typeof drive.permissions.create).toBe('function');
    expect(typeof drive.files.delete).toBe('function');
  });

  it('既定 factory を実行して API client の各メソッドを構築する', async () => {
    const client = await defaultSheetsClientFactory('/tmp/hubble-test-service-account.json');

    expect(typeof client.createSpreadsheet).toBe('function');
    expect(typeof client.appendValues).toBe('function');
    expect(typeof client.renameFirstSheet).toBe('function');
    expect(typeof client.addSheet).toBe('function');
    expect(typeof client.shareWithWriter).toBe('function');
    expect(typeof client.deleteSpreadsheet).toBe('function');
  });
});

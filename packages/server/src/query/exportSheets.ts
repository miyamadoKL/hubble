/**
 * クエリ結果を Google Sheets へエクスポートする。
 *
 * googleapis は重いため、このモジュールの既定 factory から使用時だけ dynamic import する。
 */
import type { QueryColumn } from '@hubble/contracts';
import type { ExportConfig } from '../config';
import { AppError } from '../errors';
import { formatCell } from './csv';
import {
  openQueryResultEvents,
  type QueryResultEvent,
  type QueryResultEventInput,
} from './resultEvents';

const SHEETS_CELL_LIMIT = 10_000_000;
const SHEETS_SAFE_CELL_LIMIT = Math.floor(SHEETS_CELL_LIMIT * 0.8);
const SHEETS_APPEND_ROWS = 10_000;

/** Google API の薄い抽象。テストではこの境界をフェイクする。 */
export interface SheetsApiClient {
  createSpreadsheet(title: string): Promise<{ spreadsheetId: string; url: string }>;
  appendValues(spreadsheetId: string, values: unknown[][], range?: string): Promise<void>;
  renameFirstSheet(spreadsheetId: string, title: string): Promise<void>;
  addSheet(spreadsheetId: string, title: string): Promise<void>;
  shareWithWriter(spreadsheetId: string, email: string): Promise<void>;
  /** 作成後に失敗した spreadsheet を削除する。 */
  deleteSpreadsheet(spreadsheetId: string): Promise<void>;
}

type SheetsClientFactoryResult = Omit<SheetsApiClient, 'deleteSpreadsheet'> &
  Partial<Pick<SheetsApiClient, 'deleteSpreadsheet'>>;

/** Sheets client factory の差し替えポイント。 */
export type SheetsClientFactory = (credentialsFile: string) => Promise<SheetsClientFactoryResult>;

/** googleapis を dynamic import し、サービスアカウント client を作る。 */
export const defaultSheetsClientFactory: SheetsClientFactory = async (credentialsFile) => {
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsFile,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  return {
    async createSpreadsheet(title) {
      const created = await sheets.spreadsheets.create({
        requestBody: { properties: { title } },
        fields: 'spreadsheetId,spreadsheetUrl,sheets.properties',
      });
      const spreadsheetId = created.data.spreadsheetId;
      if (!spreadsheetId) throw new Error('Google Sheets API did not return spreadsheetId');
      return {
        spreadsheetId,
        url:
          created.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
      };
    },
    async appendValues(spreadsheetId, values, range = 'A1') {
      if (values.length === 0) return;
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
    },
    async renameFirstSheet(spreadsheetId, title) {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties',
      });
      const sheetId = meta.data.sheets?.[0]?.properties?.sheetId;
      if (sheetId === undefined || sheetId === null) {
        throw new Error('Google Sheets API did not return the first sheet id');
      }
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, title },
                fields: 'title',
              },
            },
          ],
        },
      });
    },
    async addSheet(spreadsheetId, title) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      });
    },
    async shareWithWriter(spreadsheetId, email) {
      await drive.permissions.create({
        fileId: spreadsheetId,
        sendNotificationEmail: false,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: email,
        },
      });
    },
    async deleteSpreadsheet(spreadsheetId) {
      await drive.files.delete({ fileId: spreadsheetId });
    },
  };
};

/** 後段の失敗時に作成済み spreadsheet を可能な範囲で削除する。 */
async function deleteCreatedSpreadsheet(
  client: SheetsClientFactoryResult,
  spreadsheetId: string,
): Promise<void> {
  try {
    await client.deleteSpreadsheet?.(spreadsheetId);
  } catch {
    // 削除失敗で本処理のエラーを上書きしない。
  }
}

/** Sheets export service。 */
export class SheetsExporter {
  constructor(
    private readonly config: ExportConfig['sheets'],
    private readonly clientFactory: SheetsClientFactory = defaultSheetsClientFactory,
  ) {}

  /** 行イベントを新規 spreadsheet へ書き込み、principal の email へ writer 共有する。 */
  async export(input: {
    title: string;
    email?: string;
    events: AsyncGenerator<QueryResultEvent>;
  }): Promise<{ spreadsheetId: string; url: string }> {
    const credentialsFile = this.config.credentialsFile;
    if (!credentialsFile) {
      throw AppError.notImplemented(
        'Google Sheets export is disabled. Set EXPORT_SHEETS_CREDENTIALS_FILE to enable it.',
      );
    }
    if (!input.email) {
      throw AppError.badRequest('Google Sheets export requires an authenticated principal email.');
    }

    const client = await this.clientFactory(credentialsFile);
    const created = await client.createSpreadsheet(input.title);
    try {
      let columns: QueryColumn[] = [];
      let rows = 0;
      let chunk: unknown[][] = [];

      const flush = async (): Promise<void> => {
        if (chunk.length === 0) return;
        await client.appendValues(created.spreadsheetId, chunk);
        chunk = [];
      };

      for await (const event of input.events) {
        if (event.type === 'columns') {
          columns = event.columns;
          chunk.push(event.columns.map((column) => column.name));
          continue;
        }

        rows += 1;
        const cellCount = (rows + 1) * Math.max(columns.length, event.row.length);
        if (cellCount > SHEETS_SAFE_CELL_LIMIT) {
          throw new AppError(413, {
            code: 'RESULT_TOO_LARGE',
            message:
              'Google Sheets export is limited to 8,000,000 cells in Hubble. Use S3 or CSV for larger results.',
          });
        }
        chunk.push(event.row.map(toSheetsCellValue));
        if (chunk.length >= SHEETS_APPEND_ROWS) await flush();
      }
      await flush();
      await client.shareWithWriter(created.spreadsheetId, input.email);
      return created;
    } catch (err) {
      await deleteCreatedSpreadsheet(client, created.spreadsheetId);
      throw err;
    }
  }

  /** 行イベントを複数シートの新規 spreadsheet へ書き込み、writer 共有する。 */
  async exportMultiSheet(input: {
    title: string;
    email?: string;
    sheets: ReadonlyArray<{ name: string; events: QueryResultEventInput }>;
  }): Promise<{ spreadsheetId: string; url: string }> {
    const credentialsFile = this.config.credentialsFile;
    if (!credentialsFile) {
      throw AppError.notImplemented(
        'Google Sheets export is disabled. Set EXPORT_SHEETS_CREDENTIALS_FILE to enable it.',
      );
    }
    if (!input.email) {
      throw AppError.badRequest('Google Sheets export requires an authenticated principal email.');
    }
    if (input.sheets.length === 0) {
      throw AppError.badRequest('Google Sheets export requires at least one sheet.');
    }

    const client = await this.clientFactory(credentialsFile);
    const created = await client.createSpreadsheet(input.title);
    try {
      let totalCells = 0;

      for (let index = 0; index < input.sheets.length; index += 1) {
        const sheet = input.sheets[index]!;
        if (index === 0) {
          await client.renameFirstSheet(created.spreadsheetId, sheet.name);
        } else {
          await client.addSheet(created.spreadsheetId, sheet.name);
        }

        let columns: QueryColumn[] = [];
        let chunk: unknown[][] = [];
        const range = `'${sheet.name.replace(/'/g, "''")}'!A1`;

        const flush = async (): Promise<void> => {
          if (chunk.length === 0) return;
          await client.appendValues(created.spreadsheetId, chunk, range);
          chunk = [];
        };

        for await (const event of await openQueryResultEvents(sheet.events)) {
          if (event.type === 'columns') {
            columns = event.columns;
            totalCells += event.columns.length;
            chunk.push(event.columns.map((column) => column.name));
            continue;
          }

          totalCells += Math.max(columns.length, event.row.length);
          if (totalCells > SHEETS_SAFE_CELL_LIMIT) {
            throw new AppError(413, {
              code: 'RESULT_TOO_LARGE',
              message:
                'Google Sheets export is limited to 8,000,000 cells in Hubble. Use S3 or CSV for larger results.',
            });
          }
          chunk.push(event.row.map(toSheetsCellValue));
          if (chunk.length >= SHEETS_APPEND_ROWS) await flush();
        }
        await flush();
      }

      await client.shareWithWriter(created.spreadsheetId, input.email);
      return created;
    } catch (err) {
      await deleteCreatedSpreadsheet(client, created.spreadsheetId);
      throw err;
    }
  }
}

function toSheetsCellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  return formatCell(value);
}

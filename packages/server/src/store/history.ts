import type { HistoryResponse, QueryHistoryEntry, QueryState } from '@hubble/contracts';
import { queryHistoryEntrySchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';

interface HistoryRow {
  id: string;
  statement: string;
  catalog: string | null;
  schema: string | null;
  trino_query_id: string | null;
  state: string;
  row_count: number;
  elapsed_ms: number;
  error_message: string | null;
  notebook_id: string | null;
  cell_id: string | null;
  submitted_at: string;
}

export interface HistoryInsert {
  id: string;
  statement: string;
  catalog?: string;
  schema?: string;
  state: QueryState;
  /** Owning principal (design.md §11). */
  owner: string;
  notebookId?: string;
  cellId?: string;
  submittedAt: string;
}

export interface HistoryUpdate {
  state: QueryState;
  rowCount: number;
  elapsedMs: number;
  trinoQueryId?: string;
  errorMessage?: string;
}

const STATEMENT_MAX = 2000;

/**
 * Query history (Hue's `is_history` equivalent). A row is inserted on submit
 * and updated when the query settles (design.md §4).
 */
export class HistoryRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Insert a history row at submission time. */
  async insert(entry: HistoryInsert): Promise<void> {
    // Literal NULL/0 for the columns set at settle time (trino_query_id,
    // row_count, elapsed_ms, error_message); the rest are bound positionally.
    await this.db.run(
      `INSERT INTO query_history (id, statement, catalog, schema, trino_query_id, state, row_count, elapsed_ms, error_message, owner, notebook_id, cell_id, submitted_at)
       VALUES (?, ?, ?, ?, NULL, ?, 0, 0, NULL, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.statement.slice(0, STATEMENT_MAX),
        entry.catalog ?? null,
        entry.schema ?? null,
        entry.state,
        entry.owner,
        entry.notebookId ?? null,
        entry.cellId ?? null,
        entry.submittedAt,
      ],
    );
  }

  /** Update a history row when the query settles. No-op if the row is gone. */
  async update(id: string, update: HistoryUpdate): Promise<void> {
    await this.db.run(
      `UPDATE query_history
       SET state=?, row_count=?, elapsed_ms=?, trino_query_id=?, error_message=?
       WHERE id=?`,
      [
        update.state,
        update.rowCount,
        update.elapsedMs,
        update.trinoQueryId ?? null,
        update.errorMessage ?? null,
        id,
      ],
    );
  }

  async get(owner: string, id: string): Promise<QueryHistoryEntry | undefined> {
    const rows = await this.db.query<HistoryRow>(
      'SELECT * FROM query_history WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0] ? rowToEntry(rows[0]) : undefined;
  }

  async list(
    owner: string,
    opts: { offset?: number; limit?: number; state?: QueryState },
  ): Promise<HistoryResponse> {
    const offset = Math.max(opts.offset ?? 0, 0);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where = opts.state ? 'WHERE owner = ? AND state = ?' : 'WHERE owner = ?';
    const params: SqlParam[] = opts.state ? [owner, opts.state] : [owner];

    const countRows = await this.db.query<{ c: number | string }>(
      `SELECT COUNT(*) AS c FROM query_history ${where}`,
      params,
    );
    // PostgreSQL returns COUNT(*) as a bigint string; SQLite returns a number.
    const total = Number(countRows[0]?.c ?? 0);

    const rows = await this.db.query<HistoryRow>(
      `SELECT * FROM query_history ${where} ORDER BY submitted_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      items: rows.map(rowToEntry),
      offset,
      limit,
      total,
    };
  }
}

function rowToEntry(row: HistoryRow): QueryHistoryEntry {
  const entry: QueryHistoryEntry = {
    id: row.id,
    statement: row.statement,
    state: row.state as QueryState,
    rowCount: Number(row.row_count),
    elapsedMs: Number(row.elapsed_ms),
    submittedAt: row.submitted_at,
  };
  if (row.catalog) entry.catalog = row.catalog;
  if (row.schema) entry.schema = row.schema;
  if (row.trino_query_id) entry.trinoQueryId = row.trino_query_id;
  if (row.error_message) entry.errorMessage = row.error_message;
  if (row.notebook_id) entry.notebookId = row.notebook_id;
  if (row.cell_id) entry.cellId = row.cell_id;
  return queryHistoryEntrySchema.parse(entry);
}

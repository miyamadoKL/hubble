import type Database from 'better-sqlite3';
import type { HistoryResponse, QueryHistoryEntry, QueryState } from '@hue-fable/contracts';
import { queryHistoryEntrySchema } from '@hue-fable/contracts';

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
  constructor(private readonly db: Database.Database) {}

  /** Insert a history row at submission time. */
  insert(entry: HistoryInsert): void {
    this.db
      .prepare(
        `INSERT INTO query_history (id, statement, catalog, schema, trino_query_id, state, row_count, elapsed_ms, error_message, owner, notebook_id, cell_id, submitted_at)
         VALUES (@id, @statement, @catalog, @schema, NULL, @state, 0, 0, NULL, @owner, @notebook_id, @cell_id, @submitted_at)`,
      )
      .run({
        id: entry.id,
        statement: entry.statement.slice(0, STATEMENT_MAX),
        catalog: entry.catalog ?? null,
        schema: entry.schema ?? null,
        state: entry.state,
        owner: entry.owner,
        notebook_id: entry.notebookId ?? null,
        cell_id: entry.cellId ?? null,
        submitted_at: entry.submittedAt,
      });
  }

  /** Update a history row when the query settles. No-op if the row is gone. */
  update(id: string, update: HistoryUpdate): void {
    this.db
      .prepare(
        `UPDATE query_history
         SET state=@state, row_count=@row_count, elapsed_ms=@elapsed_ms,
             trino_query_id=@trino_query_id, error_message=@error_message
         WHERE id=@id`,
      )
      .run({
        id,
        state: update.state,
        row_count: update.rowCount,
        elapsed_ms: update.elapsedMs,
        trino_query_id: update.trinoQueryId ?? null,
        error_message: update.errorMessage ?? null,
      });
  }

  get(owner: string, id: string): QueryHistoryEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM query_history WHERE id = ? AND owner = ?')
      .get(id, owner) as HistoryRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  list(
    owner: string,
    opts: { offset?: number; limit?: number; state?: QueryState },
  ): HistoryResponse {
    const offset = Math.max(opts.offset ?? 0, 0);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where = opts.state ? 'WHERE owner = ? AND state = ?' : 'WHERE owner = ?';
    const params: unknown[] = opts.state ? [owner, opts.state] : [owner];

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM query_history ${where}`).get(...params) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(`SELECT * FROM query_history ${where} ORDER BY submitted_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as HistoryRow[];

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
    rowCount: row.row_count,
    elapsedMs: row.elapsed_ms,
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

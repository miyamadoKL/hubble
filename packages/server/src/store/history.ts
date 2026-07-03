/**
 * クエリ実行履歴（Hue の `is_history` 相当）の永続化層。`query_history`
 * テーブルへの挿入、更新、参照を提供する。1件の履歴行は、クエリ投入時に
 * `insert()` で作成され、Trino 側でクエリが完了/失敗/キャンセルされた
 * 「settle」のタイミングで `update()` により結果列（state, row_count,
 * elapsed_ms, trino_query_id, error_message）が上書きされる（design.md §4）。
 * 全操作は `owner` principal で絞り込まれ、他ユーザーの履歴は見えない
 * （design.md §11）。
 */
import type { HistoryResponse, QueryHistoryEntry, QueryState } from '@hubble/contracts';
import { queryHistoryEntrySchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';

/**
 * `query_history` テーブルの行を SQL ドライバがそのまま返す形。列名は
 * snake_case。`trino_query_id` / `error_message` などは settle 時まで
 * NULL、`notebook_id` / `cell_id` はノートブック経由の実行のみ埋まる。
 */
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
  datasource_id: string;
  submitted_at: string;
}

/**
 * クエリ投入時（submit）に `insert()` へ渡す入力。この時点では実行結果
 * （行数、経過時間、エラー等）は未確定のため含まれない。
 */
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
  datasourceId: string;
  submittedAt: string;
}

/**
 * クエリ確定時（settle）に `update()` へ渡す入力。成功/失敗いずれの場合も
 * この形で1回だけ呼ばれ、対応する履歴行を終端状態に更新する。
 */
export interface HistoryUpdate {
  state: QueryState;
  rowCount: number;
  elapsedMs: number;
  trinoQueryId?: string;
  errorMessage?: string;
}

// 履歴に保存する SQL 文の最大長。長大なクエリでテーブルが肥大化しないよう
// insert() 側で切り詰める。
const STATEMENT_MAX = 2000;

/**
 * Query history (Hue's `is_history` equivalent). A row is inserted on submit
 * and updated when the query settles (design.md §4).
 *
 * クエリ実行履歴（Hue の `is_history` 相当）のリポジトリ。行はクエリ投入時に
 * 挿入され、クエリが確定（settle）したタイミングで更新される（design.md §4）。
 */
export class HistoryRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Insert a history row at submission time. */
  // クエリ投入時に履歴行を1件挿入する。
  async insert(entry: HistoryInsert): Promise<void> {
    // Literal NULL/0 for the columns set at settle time (trino_query_id,
    // row_count, elapsed_ms, error_message); the rest are bound positionally.
    // settle 時に確定する列（trino_query_id, row_count, elapsed_ms,
    // error_message）は SQL リテラルで NULL/0 を埋め、それ以外は
    // プレースホルダで位置バインドする。statement は STATEMENT_MAX で切り詰める。
    await this.db.run(
      `INSERT INTO query_history (id, statement, catalog, schema, trino_query_id, state, row_count, elapsed_ms, error_message, owner, notebook_id, cell_id, datasource_id, submitted_at)
       VALUES (?, ?, ?, ?, NULL, ?, 0, 0, NULL, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.statement.slice(0, STATEMENT_MAX),
        entry.catalog ?? null,
        entry.schema ?? null,
        entry.state,
        entry.owner,
        entry.notebookId ?? null,
        entry.cellId ?? null,
        entry.datasourceId,
        entry.submittedAt,
      ],
    );
  }

  /** Update a history row when the query settles. No-op if the row is gone. */
  // クエリが確定（成功/失敗/キャンセル）したタイミングで履歴行を更新する。
  // 対象行が既に存在しなくても（削除済みなど）エラーにはならず単に無視される。
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

  /** owner が所有する単一の履歴エントリを id で取得する。存在しなければ undefined。 */
  async get(owner: string, id: string): Promise<QueryHistoryEntry | undefined> {
    const rows = await this.db.query<HistoryRow>(
      'SELECT * FROM query_history WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0] ? rowToEntry(rows[0]) : undefined;
  }

  /**
   * owner の履歴一覧をページングして返す。`state` が指定されれば絞り込む。
   * offset/limit は範囲外の値をクランプする（offset は 0 以上、limit は
   * 1〜500 の範囲）。件数（total）は別クエリで数える。
   */
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
    // PostgreSQL は COUNT(*) を bigint の文字列で返すことがあるため、
    // SQLite の数値と挙動を揃えるために Number() を通す。
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

// DB 行をドメインオブジェクト `QueryHistoryEntry` へ変換する。null/未設定の
// optional フィールド（catalog, schema, trinoQueryId, errorMessage,
// notebookId, cellId）は truthy な場合のみ含め、最後に契約スキーマで検証する。
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
  if (row.datasource_id) entry.datasourceId = row.datasource_id;
  return queryHistoryEntrySchema.parse(entry);
}

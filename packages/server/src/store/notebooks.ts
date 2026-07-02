/**
 * ノートブック（Hue Notebook 相当）機能の永続化層。`notebooks` テーブルへの
 * CRUD を提供する。ノートブック本体（セル、変数、コンテキストを含む契約型
 * `Notebook` 全体）は JSON 文字列として `data` 列にそのまま保存し、`name` /
 * `description` のみ検索用に別列へ複製して抽出する。全操作は `owner`
 * principal で絞り込まれ、他ユーザーのノートブックは参照も変更もできない
 * （design.md §11）。`likeParam()` は savedQueries.ts からも再利用される
 * LIKE 検索の共通ヘルパー。
 */
import type {
  CreateNotebookRequest,
  Notebook,
  NotebookListItem,
  UpdateNotebookRequest,
} from '@hubble/contracts';
import { notebookSchema } from '@hubble/contracts';
import type { SqlDatabase } from '../db/sqlDatabase';
import { newId } from '../util/id';

/**
 * `notebooks` テーブルの行を SQL ドライバがそのまま返す形。`data` 列には
 * 契約型 `Notebook` 全体（セル、変数、コンテキストを含む）が JSON 文字列と
 * して保存されている。
 */
interface NotebookRow {
  id: string;
  name: string;
  description: string;
  data: string;
  created_at: string;
  updated_at: string;
}

/**
 * CRUD for notebooks. The full `Notebook` (cells/variables/context) is stored
 * as JSON in `data`; `name`/`description` are also extracted for search. Every
 * operation is scoped to an `owner` principal (design.md §11): a user can only
 * see / mutate their own notebooks.
 *
 * ノートブックに対する CRUD リポジトリ。`Notebook`（セル/変数/コンテキスト）
 * 全体は `data` 列に JSON として保存し、`name`/`description` は検索用に別列
 * へも抽出する。全操作は `owner` principal で絞り込まれ（design.md §11）、
 * ユーザーは自分のノートブックしか参照も変更もできない。
 */
export class NotebookRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * owner のノートブック一覧（軽量な `NotebookListItem`、`data` 列は含まない）
   * を更新日時の新しい順に返す。`query` が指定されれば name/description に
   * 対する部分一致（LIKE）で絞り込む。
   */
  async list(owner: string, query?: string): Promise<NotebookListItem[]> {
    const rows =
      query && query.trim() !== ''
        ? await this.db.query<Omit<NotebookRow, 'data'>>(
            `SELECT id, name, description, created_at, updated_at FROM notebooks
             WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
             ORDER BY updated_at DESC`,
            [owner, likeParam(query), likeParam(query)],
          )
        : await this.db.query<Omit<NotebookRow, 'data'>>(
            `SELECT id, name, description, created_at, updated_at FROM notebooks
             WHERE owner = ? ORDER BY updated_at DESC`,
            [owner],
          );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** owner が所有する単一ノートブックを id で取得する（`data` 列を含む完全な形）。 */
  async get(owner: string, id: string): Promise<Notebook | undefined> {
    const rows = await this.db.query<NotebookRow>(
      'SELECT * FROM notebooks WHERE id = ? AND owner = ?',
      [id, owner],
    );
    const row = rows[0];
    if (!row) return undefined;
    return this.rowToNotebook(row);
  }

  /** 新しいノートブックを作成する。id は `nb_` プレフィックス付きで採番される。 */
  async create(owner: string, req: CreateNotebookRequest): Promise<Notebook> {
    const nowIso = new Date().toISOString();
    // 契約スキーマでバリデーションと既定値補完（cells/variables/context の
    // 未指定は空配列/空オブジェクト）をした上でドメインオブジェクトを組み立てる。
    const notebook: Notebook = notebookSchema.parse({
      id: newId('nb_'),
      name: req.name,
      description: req.description ?? '',
      cells: req.cells ?? [],
      variables: req.variables ?? [],
      context: req.context ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.db.run(
      `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        notebook.id,
        notebook.name,
        notebook.description,
        // ノートブック全体を JSON 文字列化して data 列に保存する。
        JSON.stringify(notebook),
        owner,
        notebook.createdAt,
        notebook.updatedAt,
      ],
    );
    return notebook;
  }

  /** 既存のノートブックを更新する。対象が owner のノートブックとして存在しなければ undefined。 */
  async update(
    owner: string,
    id: string,
    req: UpdateNotebookRequest,
  ): Promise<Notebook | undefined> {
    const existing = await this.get(owner, id);
    if (!existing) return undefined;
    // 既存値の上に req の値をマージし、スキーマで再バリデーションする。
    const updated: Notebook = notebookSchema.parse({
      ...existing,
      name: req.name,
      description: req.description,
      cells: req.cells,
      variables: req.variables,
      context: req.context,
      updatedAt: new Date().toISOString(),
    });
    await this.db.run(
      `UPDATE notebooks SET name = ?, description = ?, data = ?, updated_at = ?
       WHERE id = ? AND owner = ?`,
      [updated.name, updated.description, JSON.stringify(updated), updated.updatedAt, id, owner],
    );
    return updated;
  }

  /** ノートブックを削除する。削除できたら true、対象が存在しなければ false。 */
  async delete(owner: string, id: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM notebooks WHERE id = ? AND owner = ? RETURNING id',
      [id, owner],
    );
    return deleted.length > 0;
  }

  private rowToNotebook(row: NotebookRow): Notebook {
    // `data` is the source of truth; parse + validate against the contract.
    // `data` 列（JSON 文字列）が正であり、name/description 列は検索用の複製に
    // すぎないため無視する。パース結果を契約スキーマで検証してから返す。
    return notebookSchema.parse(JSON.parse(row.data));
  }
}

/** Escape LIKE wildcards and wrap with `%…%` for a contains match. */
// LIKE 検索のワイルドカード（\, %, _）をエスケープしてから `%…%` で囲み、
// 部分一致（contains）検索用のパターンに変換する。呼び出し側の SQL は
// `ESCAPE '\\'` を指定してこのエスケープ文字を認識する必要がある。
export function likeParam(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

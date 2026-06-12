import type {
  CreateNotebookRequest,
  Notebook,
  NotebookListItem,
  UpdateNotebookRequest,
} from '@hubble/contracts';
import { notebookSchema } from '@hubble/contracts';
import type { SqlDatabase } from '../db/sqlDatabase';
import { newId } from '../util/id';

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
 */
export class NotebookRepository {
  constructor(private readonly db: SqlDatabase) {}

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

  async get(owner: string, id: string): Promise<Notebook | undefined> {
    const rows = await this.db.query<NotebookRow>(
      'SELECT * FROM notebooks WHERE id = ? AND owner = ?',
      [id, owner],
    );
    const row = rows[0];
    if (!row) return undefined;
    return this.rowToNotebook(row);
  }

  async create(owner: string, req: CreateNotebookRequest): Promise<Notebook> {
    const nowIso = new Date().toISOString();
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
        JSON.stringify(notebook),
        owner,
        notebook.createdAt,
        notebook.updatedAt,
      ],
    );
    return notebook;
  }

  async update(
    owner: string,
    id: string,
    req: UpdateNotebookRequest,
  ): Promise<Notebook | undefined> {
    const existing = await this.get(owner, id);
    if (!existing) return undefined;
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

  async delete(owner: string, id: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM notebooks WHERE id = ? AND owner = ? RETURNING id',
      [id, owner],
    );
    return deleted.length > 0;
  }

  private rowToNotebook(row: NotebookRow): Notebook {
    // `data` is the source of truth; parse + validate against the contract.
    return notebookSchema.parse(JSON.parse(row.data));
  }
}

/** Escape LIKE wildcards and wrap with `%…%` for a contains match. */
export function likeParam(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

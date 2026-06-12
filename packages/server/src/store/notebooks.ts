import type Database from 'better-sqlite3';
import type {
  CreateNotebookRequest,
  Notebook,
  NotebookListItem,
  UpdateNotebookRequest,
} from '@hubble/contracts';
import { notebookSchema } from '@hubble/contracts';
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
  constructor(private readonly db: Database.Database) {}

  list(owner: string, query?: string): NotebookListItem[] {
    const rows = (
      query && query.trim() !== ''
        ? this.db
            .prepare(
              `SELECT id, name, description, created_at, updated_at FROM notebooks
               WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
               ORDER BY updated_at DESC`,
            )
            .all(owner, likeParam(query), likeParam(query))
        : this.db
            .prepare(
              `SELECT id, name, description, created_at, updated_at FROM notebooks
               WHERE owner = ? ORDER BY updated_at DESC`,
            )
            .all(owner)
    ) as Omit<NotebookRow, 'data'>[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  get(owner: string, id: string): Notebook | undefined {
    const row = this.db
      .prepare('SELECT * FROM notebooks WHERE id = ? AND owner = ?')
      .get(id, owner) as NotebookRow | undefined;
    if (!row) return undefined;
    return this.rowToNotebook(row);
  }

  create(owner: string, req: CreateNotebookRequest): Notebook {
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
    this.db
      .prepare(
        `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at)
         VALUES (@id, @name, @description, @data, @owner, @created_at, @updated_at)`,
      )
      .run({
        id: notebook.id,
        name: notebook.name,
        description: notebook.description,
        data: JSON.stringify(notebook),
        owner,
        created_at: notebook.createdAt,
        updated_at: notebook.updatedAt,
      });
    return notebook;
  }

  update(owner: string, id: string, req: UpdateNotebookRequest): Notebook | undefined {
    const existing = this.get(owner, id);
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
    this.db
      .prepare(
        `UPDATE notebooks SET name = @name, description = @description, data = @data, updated_at = @updated_at
         WHERE id = @id AND owner = @owner`,
      )
      .run({
        id,
        owner,
        name: updated.name,
        description: updated.description,
        data: JSON.stringify(updated),
        updated_at: updated.updatedAt,
      });
    return updated;
  }

  delete(owner: string, id: string): boolean {
    const info = this.db.prepare('DELETE FROM notebooks WHERE id = ? AND owner = ?').run(id, owner);
    return info.changes > 0;
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

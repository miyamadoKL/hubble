import type Database from 'better-sqlite3';
import type {
  CreateSavedQueryRequest,
  SavedQuery,
  UpdateSavedQueryRequest,
} from '@hubble/contracts';
import { savedQuerySchema } from '@hubble/contracts';
import { newId } from '../util/id';
import { likeParam } from './notebooks';

interface SavedQueryRow {
  id: string;
  name: string;
  description: string;
  statement: string;
  catalog: string | null;
  schema: string | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
}

/**
 * CRUD for saved queries with a `?query=` LIKE search over name/statement.
 * Every operation is scoped to an `owner` principal (design.md §11).
 */
export class SavedQueryRepository {
  constructor(private readonly db: Database.Database) {}

  list(owner: string, query?: string): SavedQuery[] {
    const rows = (
      query && query.trim() !== ''
        ? this.db
            .prepare(
              `SELECT * FROM saved_queries
               WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
               ORDER BY is_favorite DESC, updated_at DESC`,
            )
            .all(owner, likeParam(query), likeParam(query), likeParam(query))
        : this.db
            .prepare(
              `SELECT * FROM saved_queries WHERE owner = ? ORDER BY is_favorite DESC, updated_at DESC`,
            )
            .all(owner)
    ) as SavedQueryRow[];
    return rows.map(rowToSavedQuery);
  }

  get(owner: string, id: string): SavedQuery | undefined {
    const row = this.db
      .prepare('SELECT * FROM saved_queries WHERE id = ? AND owner = ?')
      .get(id, owner) as SavedQueryRow | undefined;
    return row ? rowToSavedQuery(row) : undefined;
  }

  create(owner: string, req: CreateSavedQueryRequest): SavedQuery {
    const nowIso = new Date().toISOString();
    const saved: SavedQuery = savedQuerySchema.parse({
      id: newId('sq_'),
      name: req.name,
      description: req.description ?? '',
      statement: req.statement,
      catalog: req.catalog,
      schema: req.schema,
      isFavorite: req.isFavorite ?? false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    this.db
      .prepare(
        `INSERT INTO saved_queries (id, name, description, statement, catalog, schema, is_favorite, owner, created_at, updated_at)
         VALUES (@id, @name, @description, @statement, @catalog, @schema, @is_favorite, @owner, @created_at, @updated_at)`,
      )
      .run(toRow(saved, owner));
    return saved;
  }

  update(owner: string, id: string, req: UpdateSavedQueryRequest): SavedQuery | undefined {
    const existing = this.get(owner, id);
    if (!existing) return undefined;
    const updated: SavedQuery = savedQuerySchema.parse({
      ...existing,
      name: req.name,
      description: req.description,
      statement: req.statement,
      catalog: req.catalog,
      schema: req.schema,
      isFavorite: req.isFavorite,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        `UPDATE saved_queries SET name=@name, description=@description, statement=@statement,
           catalog=@catalog, schema=@schema, is_favorite=@is_favorite, updated_at=@updated_at
         WHERE id=@id AND owner=@owner`,
      )
      .run(toRow(updated, owner));
    return updated;
  }

  delete(owner: string, id: string): boolean {
    return (
      this.db.prepare('DELETE FROM saved_queries WHERE id = ? AND owner = ?').run(id, owner)
        .changes > 0
    );
  }
}

function rowToSavedQuery(row: SavedQueryRow): SavedQuery {
  const q: SavedQuery = {
    id: row.id,
    name: row.name,
    description: row.description,
    statement: row.statement,
    isFavorite: row.is_favorite !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.catalog) q.catalog = row.catalog;
  if (row.schema) q.schema = row.schema;
  return savedQuerySchema.parse(q);
}

function toRow(q: SavedQuery, owner: string): Record<string, unknown> {
  return {
    id: q.id,
    name: q.name,
    description: q.description,
    statement: q.statement,
    catalog: q.catalog ?? null,
    schema: q.schema ?? null,
    is_favorite: q.isFavorite ? 1 : 0,
    owner,
    created_at: q.createdAt,
    updated_at: q.updatedAt,
  };
}

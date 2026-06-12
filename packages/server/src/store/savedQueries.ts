import type {
  CreateSavedQueryRequest,
  SavedQuery,
  UpdateSavedQueryRequest,
} from '@hubble/contracts';
import { savedQuerySchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
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
  constructor(private readonly db: SqlDatabase) {}

  async list(owner: string, query?: string): Promise<SavedQuery[]> {
    const rows =
      query && query.trim() !== ''
        ? await this.db.query<SavedQueryRow>(
            `SELECT * FROM saved_queries
             WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
             ORDER BY is_favorite DESC, updated_at DESC`,
            [owner, likeParam(query), likeParam(query), likeParam(query)],
          )
        : await this.db.query<SavedQueryRow>(
            `SELECT * FROM saved_queries WHERE owner = ? ORDER BY is_favorite DESC, updated_at DESC`,
            [owner],
          );
    return rows.map(rowToSavedQuery);
  }

  async get(owner: string, id: string): Promise<SavedQuery | undefined> {
    const rows = await this.db.query<SavedQueryRow>(
      'SELECT * FROM saved_queries WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0] ? rowToSavedQuery(rows[0]) : undefined;
  }

  async create(owner: string, req: CreateSavedQueryRequest): Promise<SavedQuery> {
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
    await this.db.run(
      `INSERT INTO saved_queries (id, name, description, statement, catalog, schema, is_favorite, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertParams(saved, owner),
    );
    return saved;
  }

  async update(
    owner: string,
    id: string,
    req: UpdateSavedQueryRequest,
  ): Promise<SavedQuery | undefined> {
    const existing = await this.get(owner, id);
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
    await this.db.run(
      `UPDATE saved_queries SET name=?, description=?, statement=?,
         catalog=?, schema=?, is_favorite=?, updated_at=?
       WHERE id=? AND owner=?`,
      [
        updated.name,
        updated.description,
        updated.statement,
        updated.catalog ?? null,
        updated.schema ?? null,
        updated.isFavorite ? 1 : 0,
        updated.updatedAt,
        id,
        owner,
      ],
    );
    return updated;
  }

  async delete(owner: string, id: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM saved_queries WHERE id = ? AND owner = ? RETURNING id',
      [id, owner],
    );
    return deleted.length > 0;
  }
}

function rowToSavedQuery(row: SavedQueryRow): SavedQuery {
  const q: SavedQuery = {
    id: row.id,
    name: row.name,
    description: row.description,
    statement: row.statement,
    // SQLite stores 0/1; PostgreSQL's INTEGER column round-trips the same value.
    isFavorite: Number(row.is_favorite) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.catalog) q.catalog = row.catalog;
  if (row.schema) q.schema = row.schema;
  return savedQuerySchema.parse(q);
}

/** Positional params for the INSERT, matching the column order above. */
function insertParams(q: SavedQuery, owner: string): SqlParam[] {
  return [
    q.id,
    q.name,
    q.description,
    q.statement,
    q.catalog ?? null,
    q.schema ?? null,
    q.isFavorite ? 1 : 0,
    owner,
    q.createdAt,
    q.updatedAt,
  ];
}

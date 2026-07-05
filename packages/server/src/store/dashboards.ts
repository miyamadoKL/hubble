/**
 * Dashboard 機能の永続化層。`dashboards` テーブルへの CRUD を提供する。
 * Dashboard 本体（widget 集合を含む契約型 `Dashboard` 全体）は JSON 文字列として
 * `data` 列にそのまま保存し、`name` / `description` のみ検索用に別列へ複製して
 * 抽出する。所有分に加え、`document_shares` 経由で共有された Dashboard も
 * accessor 向けに一覧・取得できる。
 */
import type {
  CreateDashboardRequest,
  Dashboard,
  DashboardListItem,
  MyPermission,
  UpdateDashboardRequest,
} from '@hubble/contracts';
import { dashboardSchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';
import { DocumentShareRepository, type ShareAccessor, type StoreForbidden } from './documentShares';
import { likeParam } from './notebooks';

/**
 * `dashboards` テーブルの行を SQL ドライバがそのまま返す形。`data` 列には
 * 契約型 `Dashboard` 全体（widget 集合を含む）が JSON 文字列として保存されている。
 */
interface DashboardRow {
  id: string;
  name: string;
  description: string;
  data: string;
  owner: string;
  created_at: string;
  updated_at: string;
}

type DashboardListRow = Pick<
  DashboardRow,
  'id' | 'name' | 'description' | 'data' | 'created_at' | 'updated_at' | 'owner'
>;

/**
 * Dashboard に対する CRUD リポジトリ。`Dashboard` 全体は `data` 列に JSON として
 * 保存し、`name`/`description` は検索用に別列へも抽出する。全操作は accessor で
 * スコープされ、所有分に加え document_shares 経由で共有された Dashboard も参照できる。
 */
export class DashboardRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly shares: DocumentShareRepository,
  ) {}

  /**
   * accessor が所有または共有経由で参照できる Dashboard 一覧（軽量な
   * `DashboardListItem`、`data` 列の widget 本体は含まない）を更新日時の新しい順に返す。
   * `query` が指定されれば name/description に対する部分一致（LIKE）で絞り込む。
   */
  async list(accessor: ShareAccessor, query?: string): Promise<DashboardListItem[]> {
    const ownedRows = await this.listOwnedRows(accessor.user, query);
    const ownedIds = new Set(ownedRows.map((row) => row.id));
    const sharedIds = await this.shares.listAccessibleDocumentIds('dashboard', accessor);
    const sharedOnlyIds = [...sharedIds.keys()].filter((id) => !ownedIds.has(id));
    const sharedRows =
      sharedOnlyIds.length > 0 ? await this.fetchListRowsByIds(sharedOnlyIds, query) : [];

    const items: DashboardListItem[] = [
      ...ownedRows.map((row) => rowToListItem(row, row.owner, 'owner')),
      ...sharedRows.map((row) => rowToListItem(row, row.owner, sharedIds.get(row.id)!)),
    ];
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items;
  }

  /**
   * owner 条件なしで id から Dashboard を取得する。
   * ガバナンス判定専用。認可は呼び出し側の責務で、返り値を API レスポンスへ直接使わないこと。
   */
  async getByIdUnscoped(id: string): Promise<Dashboard | undefined> {
    const row = await this.getRowById(id);
    return row ? this.rowToDashboard(row) : undefined;
  }

  /** accessor が参照可能な単一 Dashboard を id で取得する（`data` 列を含む完全な形）。 */
  async get(accessor: ShareAccessor, id: string): Promise<Dashboard | undefined> {
    const owned = await this.getOwnedRow(id, accessor.user);
    if (owned) {
      return withAccessMeta(this.rowToDashboard(owned), owned.owner, 'owner');
    }
    const permission = await this.shares.resolvePermission('dashboard', id, accessor);
    if (!permission) return undefined;
    const row = await this.getRowById(id);
    if (!row) return undefined;
    return withAccessMeta(this.rowToDashboard(row), row.owner, permission);
  }

  /** 新しい Dashboard を作成する。id は `dsh_` プレフィックス付きで採番される。 */
  async create(owner: string, req: CreateDashboardRequest): Promise<Dashboard> {
    const nowIso = new Date().toISOString();
    const dashboard: Dashboard = dashboardSchema.parse({
      id: newId('dsh_'),
      name: req.name,
      description: req.description ?? '',
      widgets: req.widgets ?? [],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.db.run(
      `INSERT INTO dashboards (id, name, description, data, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        dashboard.id,
        dashboard.name,
        dashboard.description,
        JSON.stringify(dashboard),
        owner,
        dashboard.createdAt,
        dashboard.updatedAt,
      ],
    );
    return dashboard;
  }

  /**
   * 既存の Dashboard を更新する。owner または edit 共有者のみ更新可能。
   * view のみの場合は 'forbidden'、対象が存在しないか権限がなければ undefined。
   */
  async update(
    accessor: ShareAccessor,
    id: string,
    req: UpdateDashboardRequest,
  ): Promise<Dashboard | undefined | StoreForbidden> {
    const owned = await this.getOwnedRow(id, accessor.user);
    if (owned) {
      return this.applyUpdate(owned, req, accessor.user, 'owner');
    }

    const permission = await this.shares.resolvePermission('dashboard', id, accessor);
    if (!permission) return undefined;
    if (permission === 'view') return 'forbidden';

    const existing = await this.getRowById(id);
    if (!existing) return undefined;
    return this.applyUpdate(existing, req, existing.owner, 'edit');
  }

  /**
   * Dashboard を削除する。owner のみ可能。削除できたら true、対象が
   * 存在しなければ false、共有されているが owner でない場合は 'forbidden'。
   */
  async delete(accessor: ShareAccessor, id: string): Promise<boolean | StoreForbidden> {
    const owner = await this.getOwner(id);
    if (!owner) return false;
    if (owner !== accessor.user) {
      const permission = await this.shares.resolvePermission('dashboard', id, accessor);
      if (permission) return 'forbidden';
      return false;
    }

    return this.db.transaction(async (tx) => {
      const deleted = await tx.query<{ id: string }>(
        'DELETE FROM dashboards WHERE id = ? AND owner = ? RETURNING id',
        [id, accessor.user],
      );
      if (deleted.length === 0) return false;
      await new DocumentShareRepository(tx).deleteForDocument('dashboard', id);
      return true;
    });
  }

  /** ドキュメント id から owner user id を返す。存在しなければ undefined。 */
  async getOwner(id: string): Promise<string | undefined> {
    const rows = await this.db.query<{ owner: string }>(
      'SELECT owner FROM dashboards WHERE id = ?',
      [id],
    );
    return rows[0]?.owner;
  }

  private async listOwnedRows(owner: string, query?: string): Promise<DashboardListRow[]> {
    if (query && query.trim() !== '') {
      return this.db.query<DashboardListRow>(
        `SELECT id, name, description, data, owner, created_at, updated_at FROM dashboards
         WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC`,
        [owner, likeParam(query), likeParam(query)],
      );
    }
    return this.db.query<DashboardListRow>(
      `SELECT id, name, description, data, owner, created_at, updated_at FROM dashboards
       WHERE owner = ? ORDER BY updated_at DESC`,
      [owner],
    );
  }

  private async fetchListRowsByIds(
    ids: readonly string[],
    query?: string,
  ): Promise<DashboardListRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const params: SqlParam[] = [...ids];
    let sql = `SELECT id, name, description, data, owner, created_at, updated_at FROM dashboards WHERE id IN (${placeholders})`;
    if (query && query.trim() !== '') {
      sql += ` AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`;
      params.push(likeParam(query), likeParam(query));
    }
    return this.db.query<DashboardListRow>(sql, params);
  }

  private async getOwnedRow(id: string, owner: string): Promise<DashboardRow | undefined> {
    const rows = await this.db.query<DashboardRow>(
      'SELECT * FROM dashboards WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0];
  }

  private async getRowById(id: string): Promise<DashboardRow | undefined> {
    const rows = await this.db.query<DashboardRow>('SELECT * FROM dashboards WHERE id = ?', [id]);
    return rows[0];
  }

  private async applyUpdate(
    existing: DashboardRow,
    req: UpdateDashboardRequest,
    owner: string,
    myPermission: MyPermission,
  ): Promise<Dashboard> {
    const updated: Dashboard = dashboardSchema.parse({
      ...this.rowToDashboard(existing),
      name: req.name,
      description: req.description,
      widgets: req.widgets,
      updatedAt: new Date().toISOString(),
    });
    await this.db.run(
      `UPDATE dashboards SET name = ?, description = ?, data = ?, updated_at = ?
       WHERE id = ? AND owner = ?`,
      [
        updated.name,
        updated.description,
        JSON.stringify(updated),
        updated.updatedAt,
        existing.id,
        owner,
      ],
    );
    return withAccessMeta(updated, owner, myPermission);
  }

  private rowToDashboard(row: DashboardRow): Dashboard {
    // `data` 列（JSON 文字列）が正であり、name/description 列は検索用の複製に
    // すぎないため無視する。パース結果を契約スキーマで検証してから返す。
    return dashboardSchema.parse(JSON.parse(row.data));
  }
}

function withAccessMeta(
  dashboard: Dashboard,
  owner: string,
  myPermission: MyPermission,
): Dashboard {
  return { ...dashboard, owner, myPermission };
}

function widgetCountFromData(data: string): number {
  try {
    const parsed = JSON.parse(data) as { widgets?: unknown[] };
    return Array.isArray(parsed.widgets) ? parsed.widgets.length : 0;
  } catch {
    return 0;
  }
}

function rowToListItem(
  row: DashboardListRow,
  owner: string,
  myPermission: MyPermission,
): DashboardListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    widgetCount: widgetCountFromData(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner,
    myPermission,
  };
}

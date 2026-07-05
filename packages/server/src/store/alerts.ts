/**
 * Alert 機能の永続化層。
 *
 * `AlertRepository` は `alerts` テーブルに対する CRUD を owner ごとに提供する。
 * 評価ループは `listAllUnmuted` で mute されていない Alert を横断取得する。
 */
import { z } from 'zod';
import type { AlertNotifications, AlertOp, AlertSelector, AlertState } from '@hubble/contracts';
import { alertNotificationsSchema, defaultAlertNotifications } from '@hubble/contracts';
import type { PrincipalIdentity } from '../auth/principal';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';

export const alertPrincipalSnapshotSchema = z.object({
  user: z.string().min(1),
  email: z.string().min(1).optional(),
  groups: z.array(z.string().min(1)).optional(),
});

export type AlertPrincipalSnapshot = z.infer<typeof alertPrincipalSnapshotSchema>;

/** DB に保存されている Alert。レスポンス専用の `nextEvalAt` は含まない。 */
export interface AlertRecord {
  id: string;
  owner: string;
  name: string;
  savedQueryId: string;
  columnName: string;
  op: AlertOp;
  value: string;
  selector: AlertSelector;
  rearm: number;
  muted: boolean;
  cron: string;
  state: AlertState;
  lastTriggeredAt: string | null;
  notifications: AlertNotifications;
  principalSnapshot: AlertPrincipalSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAlertInput {
  name: string;
  savedQueryId: string;
  columnName: string;
  op: AlertOp;
  value: string;
  selector?: AlertSelector;
  rearm?: number;
  muted?: boolean;
  cron: string;
  notifications?: AlertNotifications;
  principalSnapshot?: PrincipalIdentity;
}

export interface UpdateAlertInput {
  name?: string;
  savedQueryId?: string;
  columnName?: string;
  op?: AlertOp;
  value?: string;
  selector?: AlertSelector;
  rearm?: number;
  muted?: boolean;
  cron?: string;
  notifications?: AlertNotifications;
  principalSnapshot?: PrincipalIdentity;
  state?: AlertState;
  lastTriggeredAt?: string | null;
}

interface AlertRow {
  id: string;
  owner: string;
  name: string;
  saved_query_id: string;
  column_name: string;
  op: string;
  value: string;
  selector: string;
  rearm: number;
  muted: number;
  cron: string;
  state: string;
  last_triggered_at: string | null;
  notifications: string;
  principal_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

function parsePrincipalSnapshot(
  alertId: string,
  raw: string | null,
): AlertPrincipalSnapshot | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = alertPrincipalSnapshotSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`alert principal_snapshot ignored: alert_id=${alertId} reason=schema-validate`);
      return null;
    }
    return result.data;
  } catch {
    console.warn(`alert principal_snapshot ignored: alert_id=${alertId} reason=json-parse`);
    return null;
  }
}

function serializePrincipalSnapshot(snapshot: PrincipalIdentity | null | undefined): string | null {
  if (!snapshot) return null;
  return JSON.stringify(
    alertPrincipalSnapshotSchema.parse({
      user: snapshot.user,
      ...(snapshot.email !== undefined ? { email: snapshot.email } : {}),
      ...(snapshot.groups !== undefined ? { groups: snapshot.groups } : {}),
    }),
  );
}

function parseNotifications(alertId: string, raw: string | null): AlertNotifications {
  if (raw === null) return defaultAlertNotifications;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = alertNotificationsSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`alert notifications ignored: alert_id=${alertId} reason=schema-validate`);
      return defaultAlertNotifications;
    }
    return result.data;
  } catch {
    console.warn(`alert notifications ignored: alert_id=${alertId} reason=json-parse`);
    return defaultAlertNotifications;
  }
}

function serializeNotifications(notifications: AlertNotifications | undefined): string {
  return JSON.stringify(alertNotificationsSchema.parse(notifications ?? {}));
}

function rowToAlert(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    savedQueryId: row.saved_query_id,
    columnName: row.column_name,
    op: row.op as AlertOp,
    value: row.value,
    selector: row.selector as AlertSelector,
    rearm: Number(row.rearm),
    muted: Number(row.muted) !== 0,
    cron: row.cron,
    state: row.state as AlertState,
    lastTriggeredAt: row.last_triggered_at ?? null,
    notifications: parseNotifications(row.id, row.notifications),
    principalSnapshot: parsePrincipalSnapshot(row.id, row.principal_snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertParams(a: AlertRecord): SqlParam[] {
  return [
    a.id,
    a.owner,
    a.name,
    a.savedQueryId,
    a.columnName,
    a.op,
    a.value,
    a.selector,
    a.rearm,
    a.muted ? 1 : 0,
    a.cron,
    a.state,
    a.lastTriggeredAt,
    serializeNotifications(a.notifications),
    serializePrincipalSnapshot(a.principalSnapshot),
    a.createdAt,
    a.updatedAt,
  ];
}

/**
 * Alert の CRUD リポジトリ。ほぼ全操作は owner で絞り込む。
 * `listAllUnmuted` は評価ループ専用で owner 横断の取得を行う。
 */
export class AlertRepository {
  constructor(private readonly db: SqlDatabase) {}

  async list(owner: string): Promise<AlertRecord[]> {
    const rows = await this.db.query<AlertRow>(
      'SELECT * FROM alerts WHERE owner = ? ORDER BY updated_at DESC',
      [owner],
    );
    return rows.map(rowToAlert);
  }

  async get(owner: string, id: string): Promise<AlertRecord | undefined> {
    const rows = await this.db.query<AlertRow>('SELECT * FROM alerts WHERE id = ? AND owner = ?', [
      id,
      owner,
    ]);
    return rows[0] ? rowToAlert(rows[0]) : undefined;
  }

  async getById(id: string): Promise<AlertRecord | undefined> {
    const rows = await this.db.query<AlertRow>('SELECT * FROM alerts WHERE id = ?', [id]);
    return rows[0] ? rowToAlert(rows[0]) : undefined;
  }

  /** mute されていない全 Alert（評価 tick 用）。 */
  async listAllUnmuted(): Promise<AlertRecord[]> {
    const rows = await this.db.query<AlertRow>('SELECT * FROM alerts WHERE muted = 0 ORDER BY id');
    return rows.map(rowToAlert);
  }

  async create(owner: string, input: CreateAlertInput): Promise<AlertRecord> {
    const nowIso = new Date().toISOString();
    const record: AlertRecord = {
      id: newId('alt_'),
      owner,
      name: input.name,
      savedQueryId: input.savedQueryId,
      columnName: input.columnName,
      op: input.op,
      value: input.value,
      selector: input.selector ?? 'first',
      rearm: input.rearm ?? 0,
      muted: input.muted ?? false,
      cron: input.cron,
      state: 'unknown',
      lastTriggeredAt: null,
      notifications: input.notifications ?? defaultAlertNotifications,
      principalSnapshot: input.principalSnapshot ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.db.run(
      `INSERT INTO alerts
         (id, owner, name, saved_query_id, column_name, op, value, selector,
          rearm, muted, cron, state, last_triggered_at, notifications,
          principal_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertParams(record),
    );
    return record;
  }

  async update(
    owner: string,
    id: string,
    input: UpdateAlertInput,
  ): Promise<AlertRecord | undefined> {
    const existing = await this.get(owner, id);
    if (!existing) return undefined;
    const merged: AlertRecord = {
      ...existing,
      name: input.name ?? existing.name,
      savedQueryId: input.savedQueryId ?? existing.savedQueryId,
      columnName: input.columnName ?? existing.columnName,
      op: input.op ?? existing.op,
      value: input.value ?? existing.value,
      selector: input.selector ?? existing.selector,
      rearm: input.rearm ?? existing.rearm,
      muted: input.muted ?? existing.muted,
      cron: input.cron ?? existing.cron,
      state: input.state ?? existing.state,
      lastTriggeredAt:
        input.lastTriggeredAt !== undefined ? input.lastTriggeredAt : existing.lastTriggeredAt,
      notifications: input.notifications ?? existing.notifications,
      principalSnapshot:
        input.principalSnapshot !== undefined
          ? input.principalSnapshot
          : existing.principalSnapshot,
      updatedAt: new Date().toISOString(),
    };
    await this.db.run(
      `UPDATE alerts SET
         name = ?, saved_query_id = ?, column_name = ?, op = ?, value = ?,
         selector = ?, rearm = ?, muted = ?, cron = ?, state = ?,
         last_triggered_at = ?, notifications = ?, principal_snapshot = ?,
         updated_at = ?
       WHERE id = ? AND owner = ?`,
      [
        merged.name,
        merged.savedQueryId,
        merged.columnName,
        merged.op,
        merged.value,
        merged.selector,
        merged.rearm,
        merged.muted ? 1 : 0,
        merged.cron,
        merged.state,
        merged.lastTriggeredAt,
        serializeNotifications(merged.notifications),
        serializePrincipalSnapshot(merged.principalSnapshot),
        merged.updatedAt,
        id,
        owner,
      ],
    );
    return merged;
  }

  async delete(owner: string, id: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM alerts WHERE id = ? AND owner = ? RETURNING id',
      [id, owner],
    );
    return deleted.length > 0;
  }
}

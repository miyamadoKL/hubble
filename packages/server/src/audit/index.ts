/**
 * 監査ログの永続化と、呼び出し元を失敗させない best-effort 記録を提供する。
 */
import { z } from 'zod';
import type { SqlDatabase } from '../db/sqlDatabase';
import { newId } from '../util/id';

export const auditActionSchema = z.enum([
  'query.execute',
  'query.cancel',
  'query.kill',
  'query.result.persist',
  'csv.download',
  'export.xlsx',
  'export.s3',
  'export.sheets',
  'schedule.execute',
  'alert.evaluate',
  'workflow.execute',
  'notification.send',
  'document.share.update',
  'github.connect',
  'github.push',
  'github.pr.create',
  'github.pull',
  'ai.assist',
  'authz.denied',
  'config.reload',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

/**
 * 監査ログの `detail` 列に格納する値の型。任意階層の入れ子を許容するが、
 * `auditJsonSchema` が `z.number().finite()` で検証するため、`number` は
 * 有限値のみが許され、`NaN` や `Infinity` は許容されない。
 */
export type AuditJson =
  | string
  | number
  | boolean
  | null
  | AuditJson[]
  | { [key: string]: AuditJson };

/** 再帰型 `AuditJson` を検証するため、自己参照に `z.lazy` を使う。 */
export const auditJsonSchema: z.ZodType<AuditJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(auditJsonSchema),
    z.record(z.string(), auditJsonSchema),
  ]),
);

export const auditEventInputSchema = z.object({
  actor: z.string().min(1),
  action: auditActionSchema,
  target: z.string().nullable().optional(),
  datasource: z.string().nullable().optional(),
  detail: auditJsonSchema.optional(),
  createdAt: z.string().datetime().optional(),
});

export type AuditEventInput = z.infer<typeof auditEventInputSchema>;

/** 監査ログ 1 行分の公開表現（`AuditLogDbRow` の snake_case を変換したもの）。 */
export interface AuditLogRow {
  id: string;
  actor: string;
  action: AuditAction;
  target: string | null;
  datasource: string | null;
  detail: AuditJson;
  createdAt: string;
}

/** 監査ログのカーソル検索条件。 */
export interface AuditSearchInput {
  actor?: string;
  action?: AuditAction;
  datasource?: string;
  from?: string;
  to?: string;
  cursor?: { createdAt: string; id: string };
  limit: number;
}

/** 監査ログのカーソル検索結果。 */
export interface AuditSearchResult {
  items: AuditLogRow[];
  nextCursor?: { createdAt: string; id: string };
}

interface AuditLogDbRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  datasource: string | null;
  detail: string | AuditJson;
  created_at: string;
}

/** `audit_log` テーブルに対する記録、保持期限切れの削除、カーソル検索を提供する。 */
export class AuditRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: AuditEventInput): Promise<string> {
    const event = auditEventInputSchema.parse(input);
    const id = newId('aud_');
    const createdAt = event.createdAt ?? this.now().toISOString();
    await this.db.run(
      `INSERT INTO audit_log (id, actor, action, target, datasource, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        event.actor,
        event.action,
        event.target ?? null,
        event.datasource ?? null,
        JSON.stringify(event.detail ?? {}),
        createdAt,
      ],
    );
    return id;
  }

  /** 保持期限を過ぎた監査ログを古い順にページ削除する。 */
  async pruneBefore(cutoffIso: string, limit: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM audit_log
       WHERE id IN (
         SELECT id FROM audit_log
         WHERE created_at < $1
         ORDER BY created_at ASC, id ASC
         LIMIT $2
       )
       RETURNING id`,
      [cutoffIso, limit],
    );
    return rows.length;
  }

  async listForTest(): Promise<AuditLogRow[]> {
    const rows = await this.db.query<AuditLogDbRow>(
      'SELECT * FROM audit_log ORDER BY created_at ASC, id ASC',
    );
    return rows.map(rowToAuditLog);
  }

  /** 新しい順の複合カーソルで監査ログを検索する。 */
  async search(input: AuditSearchInput): Promise<AuditSearchResult> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (input.actor !== undefined) {
      conditions.push(`actor = $${params.length + 1}`);
      params.push(input.actor);
    }
    if (input.action !== undefined) {
      conditions.push(`action = $${params.length + 1}`);
      params.push(input.action);
    }
    if (input.datasource !== undefined) {
      conditions.push(`datasource = $${params.length + 1}`);
      params.push(input.datasource);
    }
    if (input.from !== undefined) {
      conditions.push(`created_at >= $${params.length + 1}`);
      params.push(input.from);
    }
    if (input.to !== undefined) {
      conditions.push(`created_at <= $${params.length + 1}`);
      params.push(input.to);
    }
    if (input.cursor !== undefined) {
      const cursorOffset = params.length + 1;
      conditions.push(
        `(created_at < $${cursorOffset} OR (created_at = $${cursorOffset + 1} AND id < $${cursorOffset + 2}))`,
      );
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitPlaceholder = `$${params.length + 1}`;
    const rows = await this.db.query<AuditLogDbRow>(
      `SELECT * FROM audit_log ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitPlaceholder}`,
      [...params, input.limit + 1],
    );
    const page = rows.slice(0, input.limit).map(rowToAuditLog);
    const last = page.at(-1);
    return {
      items: page,
      ...(rows.length > input.limit && last
        ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  }
}

interface AuditWriter {
  record(input: AuditEventInput): Promise<string>;
  listForTest(): Promise<AuditLogRow[]>;
  search?(input: AuditSearchInput): Promise<AuditSearchResult>;
}

/**
 * 監査ログ書き込みを best-effort にするラッパー。`record()` の失敗は本処理を
 * 止めないよう握りつぶしてログに残すだけとし、監査ログの欠落が API 応答自体を
 * 失敗させないようにする（読み取り系の `search`/`listForTest` は失敗を伝播する）。
 */
export class AuditLogger {
  constructor(
    private readonly repository: AuditWriter,
    private readonly logError: (message: string, err: unknown) => void = (m, e) =>
      console.error(m, e),
  ) {}

  async record(input: AuditEventInput): Promise<void> {
    try {
      await this.repository.record(input);
    } catch (err) {
      this.logError('audit log write failed; continuing request', err);
    }
  }

  async listForTest(): Promise<AuditLogRow[]> {
    return this.repository.listForTest();
  }

  /** 監査ログを検索する。読み取り失敗は呼び出し側へ返す。 */
  async search(input: AuditSearchInput): Promise<AuditSearchResult> {
    if (this.repository.search === undefined) {
      throw new Error('audit search is not supported by this writer');
    }
    return this.repository.search(input);
  }
}

function rowToAuditLog(row: AuditLogDbRow): AuditLogRow {
  const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  return {
    id: row.id,
    actor: row.actor,
    action: auditActionSchema.parse(row.action),
    target: row.target,
    datasource: row.datasource,
    detail: auditJsonSchema.parse(detail),
    createdAt: row.created_at,
  };
}

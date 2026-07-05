/**
 * 監査ログの永続化と、呼び出し元を失敗させない best-effort 記録を提供する。
 */
import { z } from 'zod';
import type { SqlDatabase } from '../db/sqlDatabase';
import { newId } from '../util/id';

export const auditActionSchema = z.enum([
  'query.execute',
  'query.kill',
  'query.result.persist',
  'csv.download',
  'export.xlsx',
  'export.s3',
  'export.sheets',
  'schedule.execute',
  'workflow.execute',
  'notification.send',
  'document.share.update',
  'github.connect',
  'github.push',
  'github.pr.create',
  'github.pull',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

export type AuditJson =
  | string
  | number
  | boolean
  | null
  | AuditJson[]
  | { [key: string]: AuditJson };

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

export interface AuditLogRow {
  id: string;
  actor: string;
  action: AuditAction;
  target: string | null;
  datasource: string | null;
  detail: AuditJson;
  createdAt: string;
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
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

  async listForTest(): Promise<AuditLogRow[]> {
    const rows = await this.db.query<AuditLogDbRow>(
      'SELECT * FROM audit_log ORDER BY created_at ASC, id ASC',
    );
    return rows.map(rowToAuditLog);
  }
}

interface AuditWriter {
  record(input: AuditEventInput): Promise<string>;
  listForTest(): Promise<AuditLogRow[]>;
}

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

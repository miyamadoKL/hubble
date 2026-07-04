/**
 * スケジュール実行 API ルーター（`packages/server/src/http/scheduleRoutes.ts`）。
 *
 * 「Query Scheduling」機能（cron 式で定期実行するクエリ）の CRUD と、手動実行 / 実行履歴取得を
 * 提供する Hono サブルーター。`/api/schedules` 配下にマウントされる。
 *
 * 作成や更新の際には Trino の `EXPLAIN (TYPE VALIDATE)` でステートメントの静的検証を行い、
 * 明確な構文/意味エラー (`user_error`) は 400 で弾く一方、Trino に到達できない場合は
 * 実行時（cron スケジューラー側）に再検証する前提で寛容に許可する。実際のスケジュール管理や
 * cron 計算、実行キューイングは `services.schedules` / `services.scheduler` /
 * `../schedule/cron` / `../schedule/validator` に委譲し、このファイルは HTTP の
 * リクエスト解析、オーナースコープ認可、コントラクト形状への整形のみを担当する。
 */
import { Hono } from 'hono';
import {
  createScheduleRequestSchema,
  updateScheduleRequestSchema,
  type Schedule,
  type ScheduleRunSummary,
} from '@hubble/contracts';
import type { Services } from '../services';
import { resolveEngine } from '../engine/resolve';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import type { PrincipalIdentity } from '../auth/principal';
import { requireDatasourceAccess, schedulePrincipalIdentity } from '../rbac/check';
import { resolveRoleForPrincipal } from '../rbac/resolve';
import { assertQueryWriteAllowed } from '../rbac/writeCheck';
import type { ScheduleRecord, ScheduleRunRecord } from '../store/schedules';
import { nextRunIso } from '../schedule/cron';
import type { ValidationResult } from '../schedule/validator';
import { intParam, parseJsonBody } from './validate';

type App = Hono<{ Variables: AuthVariables }>;

/**
 * Map a stored run record to the contract run summary.
 *
 * ストア層の内部表現 `ScheduleRunRecord` を、API コントラクトの `ScheduleRunSummary` 形状へ
 * マッピングする純粋な変換関数。フィールドを絞り込むことでストアの内部詳細を API に漏らさない。
 * @param run - 永続化された 1 回分の実行記録。
 * @returns レスポンスに含める実行サマリ。
 */
function toRunSummary(run: ScheduleRunRecord): ScheduleRunSummary {
  return {
    id: run.id,
    status: run.status,
    attempt: run.attempt,
    trinoQueryId: run.trinoQueryId,
    errorType: run.errorType,
    errorMessage: run.errorMessage,
    rowCount: run.rowCount,
    elapsedMs: run.elapsedMs,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/**
 * Enrich a stored schedule into the contract `Schedule` (nextRunAt + lastRun).
 *
 * 永続化されたスケジュールレコードに、リクエスト時点で計算する派生情報
 * （次回実行予定時刻と直近の実行結果）を付加して API コントラクトの `Schedule` を組み立てる。
 * @param services - `scheduleRuns` ストアへアクセスするための DI コンテナ。
 * @param record - 永続化されたスケジュール本体。
 * @returns `nextRunAt` / `lastRun` を含む完全な `Schedule`。
 */
async function toSchedule(services: Services, record: ScheduleRecord): Promise<Schedule> {
  const latest = await services.scheduleRuns.latest(record.id);
  return {
    id: record.id,
    name: record.name,
    statement: record.statement,
    catalog: record.catalog,
    schema: record.schema,
    cron: record.cron,
    enabled: record.enabled,
    retry: record.retry,
    datasourceId: record.datasourceId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    // Computed from "now": disabled schedules have no next run.
    nextRunAt: record.enabled ? nextRunIso(record.cron, new Date()) : null,
    lastRun: latest ? toRunSummary(latest) : null,
  };
}

/**
 * Turn a non-OK validation into a thrown AppError, or return for an `ok`/
 * `unavailable` result (create/update are lenient when Trino is unreachable —
 * the statement is re-validated at run time). A `user_error` becomes a 400
 * VALIDATION_ERROR carrying Trino's message + line/column.
 *
 * スケジュール作成/更新時のバリデーション結果を検査し、書き込みを許可してよいかを判定する
 * ゲート関数。`ok` または Trino 未到達による `unavailable` は許容し（実行時に再検証されるため）、
 * `user_error`（Trino が構文/意味エラーと判定）の場合のみ 400 の `AppError` を送出して書き込みを拒否する。
 * @param result - 対象エンジンの `validate()` の結果。
 * @throws {AppError} `result.kind === 'user_error'` のとき、行/列情報付きの 400 VALIDATION_ERROR。
 */
/**
 * owner のロールで書き込み文のスケジュール登録を拒否する（query.write 第 1 層）。
 */
async function assertScheduleStatementWritable(
  services: Services,
  principal: PrincipalIdentity,
  statement: string,
  engine: ReturnType<typeof resolveEngine>['engine'],
  catalog?: string | null,
  schema?: string | null,
): Promise<void> {
  const role = resolveRoleForPrincipal(services.rbac, principal);
  const ioExplain = engine.ioExplainExecution?.({
    statement,
    catalog: catalog ?? undefined,
    schema: schema ?? undefined,
    principal: principal.user,
  });
  await assertQueryWriteAllowed({
    statement,
    role,
    ioExplainClient: ioExplain?.client,
    ioExplainCtx: ioExplain?.ctx,
    ioExplainTimeoutMs: services.config.guard.estimateTimeoutMs,
  });
}

function assertValidationAllowsWrite(result: ValidationResult): void {
  if (result.ok) return;
  if (result.kind === 'unavailable') return; // lenient: allow, re-checked at run time
  // Deterministic statement error: reject the write.
  // Trino が確定的に「ステートメントが不正」と判定した場合のみ書き込みを拒否する。
  const detail: Record<string, unknown> = { trinoMessage: result.message };
  if (result.line !== undefined) detail.line = result.line;
  if (result.column !== undefined) detail.column = result.column;
  throw new AppError(400, {
    code: 'VALIDATION_ERROR',
    message: `Statement failed validation: ${result.message}`,
    details: detail,
  });
}

/**
 * Schedule routes (Query Scheduling feature), mounted under `/api/schedules`.
 * Owner-scoped. Create/update validate the statement with
 * `EXPLAIN (TYPE VALIDATE)`; manual run + run history mirror the scheduler.
 *
 * スケジュール CRUD、手動実行、実行履歴取得エンドポイントをまとめた Hono サブルーターを構築する
 * ファクトリ関数。
 * @param services - DI コンテナ。スケジュールストア、実行履歴ストア、バリデータ、
 *   スケジューラーなど、このルーターが必要とする協調オブジェクト一式を保持する。
 * @returns `/api/schedules` 配下にマウントする Hono サブアプリケーション。
 */
export function scheduleRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  // GET /api/schedules: リクエスト principal が所有するスケジュール一覧を返す。
  app.get('/', async (c) => {
    const owner = c.var.principal.user;
    const records = await services.schedules.list(owner);
    const schedules = await Promise.all(records.map((r) => toSchedule(services, r)));
    return c.json(schedules);
  });

  // POST /api/schedules: 新規スケジュールを作成する。作成前に EXPLAIN (TYPE VALIDATE) で検証する。
  app.post('/', async (c) => {
    const owner = c.var.principal.user;
    const body = await parseJsonBody(c, createScheduleRequestSchema);
    const targetDatasourceId = body.datasourceId ?? services.defaultDatasourceId;
    requireDatasourceAccess(c.var.principal.role, targetDatasourceId);
    const { datasourceId, engine } = resolveEngine(
      services.engines,
      body.datasourceId,
      services.defaultDatasourceId,
    );
    const validation = await engine.validate({
      statement: body.statement,
      catalog: body.catalog,
      schema: body.schema,
      principal: owner,
      roleName: c.var.principal.role.name,
    });
    assertValidationAllowsWrite(validation);
    await assertScheduleStatementWritable(
      services,
      c.var.principal,
      body.statement,
      engine,
      body.catalog,
      body.schema,
    );
    const record = await services.schedules.create(owner, {
      name: body.name,
      statement: body.statement,
      catalog: body.catalog,
      schema: body.schema,
      cron: body.cron,
      enabled: body.enabled,
      retry: body.retry,
      datasourceId,
      principalSnapshot: c.var.principal,
    });
    return c.json(await toSchedule(services, record), 201);
  });

  // GET /api/schedules/:id: 単一スケジュールを取得する（他ユーザー所有分は 404）。
  app.get('/:id', async (c) => {
    const owner = c.var.principal.user;
    const record = await services.schedules.get(owner, c.req.param('id'));
    if (!record) throw AppError.notFound(`Schedule ${c.req.param('id')} not found`);
    return c.json(await toSchedule(services, record));
  });

  // PATCH /api/schedules/:id: 部分更新。ステートメント/catalog/schema/cron/datasourceId の
  // いずれかが変わる場合のみ再検証する。
  app.patch('/:id', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const existing = await services.schedules.get(owner, id);
    if (!existing) throw AppError.notFound(`Schedule ${id} not found`);
    const body = await parseJsonBody(c, updateScheduleRequestSchema);
    const disableOnly = Object.keys(body).length === 1 && body.enabled === false;
    if (!disableOnly) {
      requireDatasourceAccess(c.var.principal.role, existing.datasourceId);
    }

    // Re-validate when the statement or its execution context changes.
    // 実行に影響しうるフィールドが変更された場合のみ、コストのかかる再検証を行う。
    const statementChanges =
      body.statement !== undefined ||
      body.catalog !== undefined ||
      body.schema !== undefined ||
      body.cron !== undefined ||
      body.datasourceId !== undefined;
    if (statementChanges) {
      const targetDatasourceId = body.datasourceId ?? existing.datasourceId;
      if (targetDatasourceId !== existing.datasourceId) {
        requireDatasourceAccess(c.var.principal.role, targetDatasourceId);
      }
      const { engine } = resolveEngine(
        services.engines,
        targetDatasourceId,
        services.defaultDatasourceId,
      );
      const validation = await engine.validate({
        statement: body.statement ?? existing.statement,
        catalog: body.catalog !== undefined ? body.catalog : existing.catalog,
        schema: body.schema !== undefined ? body.schema : existing.schema,
        principal: owner,
        roleName: c.var.principal.role.name,
      });
      assertValidationAllowsWrite(validation);
      await assertScheduleStatementWritable(
        services,
        c.var.principal,
        body.statement ?? existing.statement,
        engine,
        body.catalog !== undefined ? body.catalog : existing.catalog,
        body.schema !== undefined ? body.schema : existing.schema,
      );
    }

    const updated = await services.schedules.update(owner, id, {
      ...body,
      principalSnapshot: c.var.principal,
    });
    if (!updated) throw AppError.notFound(`Schedule ${id} not found`);
    return c.json(await toSchedule(services, updated));
  });

  // DELETE /api/schedules/:id: スケジュールを削除する。
  app.delete('/:id', async (c) => {
    const owner = c.var.principal.user;
    const ok = await services.schedules.delete(owner, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Schedule ${c.req.param('id')} not found`);
    return c.json({ ok: true });
  });

  // POST /api/schedules/:id/run: 手動即時実行をキューに投入し、202 で runId を返す。
  app.post('/:id/run', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const record = await services.schedules.get(owner, id);
    if (!record) throw AppError.notFound(`Schedule ${id} not found`);
    const ownerRole = resolveRoleForPrincipal(
      services.rbac,
      schedulePrincipalIdentity(owner, record.principalSnapshot),
    );
    requireDatasourceAccess(ownerRole, record.datasourceId);
    try {
      const { runId } = await services.scheduler.runManual(record);
      return c.json({ runId }, 202);
    } catch {
      // 同一スケジュールの実行が既に進行中の場合、scheduler.runManual は例外を投げる。
      // それを 409 CONFLICT に変換して、クライアントに衝突を明示する。
      throw AppError.conflict(`A run is already in progress for schedule ${id}`);
    }
  });

  // GET /api/schedules/:id/runs?limit: 直近の実行履歴一覧を返す（新しい順を想定）。
  app.get('/:id/runs', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const record = await services.schedules.get(owner, id);
    if (!record) throw AppError.notFound(`Schedule ${id} not found`);
    // limit は 1〜200 の範囲にクランプし、無制限の全件取得を防ぐ。
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 50), 1), 200);
    const runs = await services.scheduleRuns.list(id, limit);
    return c.json({ items: runs.map((r) => ({ ...toRunSummary(r), scheduleId: r.scheduleId })) });
  });

  return app;
}

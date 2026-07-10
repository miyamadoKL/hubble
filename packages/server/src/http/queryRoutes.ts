/**
 * クエリ実行 API ルーター（`packages/server/src/http/queryRoutes.ts`）。
 *
 * 「クエリ」まわりのエンドポイント群（見積り(estimate) / 投入(submit) /
 * スナップショット取得 / 行ページ取得 / キャンセル /
 * SSE によるライブ進捗配信 / CSV ダウンロード）を Hono のサブルーターとして実装する。
 *
 * このファイルは BFF (packages/server) の HTTP 層に属し、HTTP リクエストの解析、
 * オーナースコープ認可（実行したユーザー以外からは 404 にする）、レスポンス整形のみを担当する。
 * 実際の Trino 通信、実行状態の保持、Query Guard の判定ロジックなどは `services` 経由で
 * `../query/execution` や `../query/guard`、`../query/sse`、`../query/csv` に委譲する。
 * `app.ts` から `app.route('/api/queries', queryRoutes(services))` としてマウントされる。
 */
import { PassThrough, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { ZipFile } from 'yazl';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { stream } from 'hono/streaming';
import type { StreamingApi } from 'hono/utils/stream';
import {
  CSV_REEXEC_UNAVAILABLE,
  createQueryRequestSchema,
  estimateRequestSchema,
  queryExportRequestSchema,
  queryExportResponseSchema,
  type QuerySnapshot,
  type QueryRowsPage,
  type QueryExportRequest,
  type QueryExportResponse,
  resultSearchRequestSchema,
  type ResultSearchPage,
  type ResultProfile,
  type ResultSearchRequest,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { ExportConfig } from '../config';
import { resolveEngine } from '../engine/resolve';
import type { TrinoRequestContext } from '../trino/types';
import type { OverflowMode } from '../query/execution';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import { hasQueryWrite, requireDatasourceAccess } from '../rbac/check';
import { effectiveGuard, effectiveGuardLimitsSnapshot } from '../rbac/guard';
import { assertQueryWriteAllowed } from '../rbac/writeCheck';
import { disabledEstimate } from '../query/guard';
import { effectiveMaxRows, validateSessionProperties } from './queryRequest';
import { intParam, parseJsonBody } from './validate';
import { buildReplayEvents, encodeSseEvent, SSE_KEEPALIVE } from '../query/sse';
import {
  CSV_REEXEC_HEADER,
  CSV_TRUNCATED_HEADER,
  needsCsvReexec,
  csvRecord,
  statementAllowsCsvReexec,
  streamQueryCsv,
} from '../query/csv';
import type { HistoryResultRef } from '../store/history';
import {
  readPersistedResultMetadata,
  streamPersistedResultEvents,
  readPersistedRowsPage,
  openPersistedResult,
  streamPersistedCsv,
} from '../resultStore/jsonl';
import { streamQueryResultEvents, type QueryResultEventSource } from '../query/resultEvents';
import { writeXlsx, XLSX_CONTENT_TYPE, XLSX_MAX_DATA_ROWS } from '../query/xlsx';
import { buildExportObjectKey, S3ExportUploader } from '../query/exportS3';
import { SheetsExporter } from '../query/exportSheets';
import type { AuditAction } from '../audit';
import type { QueryResultEvent } from '../query/resultEvents';
import {
  profileRowsStream,
  searchRowsStream,
  RESULT_SEARCH_MAX_WINDOW,
} from '../query/exploration';

// SSE 接続が生きていることをクライアント側の中間プロキシ等に伝えるための keepalive 送信間隔。
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Query endpoints: submit/snapshot/events(SSE)/rows/cancel/CSV.
 * Mounted under `/api/queries`.
 *
 * クエリ実行系エンドポイントをまとめた Hono サブルーターを構築するファクトリ関数。
 * @param services - DI コンテナ。Trino クライアント、実行レジストリ、Query Guard 見積り
 *   サービスなど、このルーターが必要とする協調オブジェクト一式を保持する（`../services` 参照）。
 * @returns `/api/queries` 配下にマウントする Hono サブアプリケーション。認証ミドルウェアを
 *   経由済みで `AuthVariables`（principal 情報）がコンテキストにセットされている前提。
 */
export function queryRoutes(services: Services): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // POST /api/queries/estimate — Query Guard scan-cost estimate (no execution).
  // ステートメントを実行せず EXPLAIN (TYPE IO) 相当のスキャン量見積りだけを行うエンドポイント。
  app.post('/estimate', async (c) => {
    const body = await parseJsonBody(c, estimateRequestSchema);
    const principal = c.var.principal;
    const estimateDatasourceId = body.datasourceId ?? services.defaultDatasourceId;
    requireDatasourceAccess(principal.role, estimateDatasourceId);
    const effective = effectiveGuard(services.config, principal.role);
    // mode=off: never touch Trino; return a `disabled` estimate immediately.
    // Query Guard 自体が無効な設定のときは Trino に問い合わせず即座に「無効」を返す。
    if (effective.mode === 'off') {
      return c.json(disabledEstimate());
    }
    // 認証済み principal を渡すことで、Trino 側の EXPLAIN もそのユーザーとして impersonate される。
    const result = await services.estimate.estimate({
      statement: body.statement,
      catalog: body.catalog ?? services.config.defaults.catalog,
      schema: body.schema ?? services.config.defaults.schema,
      principal: principal.user,
      datasourceId: body.datasourceId,
      roleName: principal.role.name,
      guard: effective,
    });
    return c.json(result);
  });

  // POST /api/queries — accept and start; respond 202 with the queryId.
  // クエリを実際に投入するエンドポイント。非同期実行を開始し、完了を待たず 202 で queryId を返す。
  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createQueryRequestSchema);
    const principal = c.var.principal;
    const catalog = body.catalog ?? services.config.defaults.catalog;
    const schema = body.schema ?? services.config.defaults.schema;
    // body.source は非推奨。クライアント指定は無視し、エンジンの X-Trino-Source を使う。
    const ctx: TrinoRequestContext = {
      catalog,
      schema,
      // Impersonate the authenticated principal for this user query.
      user: principal.user,
      sessionProperties: validateSessionProperties(body.sessionProperties),
    };

    const queryDatasourceId = body.datasourceId ?? services.defaultDatasourceId;
    requireDatasourceAccess(principal.role, queryDatasourceId);
    const { engine } = resolveEngine(
      services.engines,
      body.datasourceId,
      services.defaultDatasourceId,
    );
    const effective = effectiveGuard(services.config, principal.role);
    const ioExplain = engine.ioExplainExecution?.({
      statement: body.statement,
      catalog,
      schema,
      principal: principal.user,
    });
    await assertQueryWriteAllowed({
      statement: body.statement,
      role: principal.role,
      ioExplainClient: ioExplain?.client,
      ioExplainCtx: ioExplain?.ctx,
      ioExplainTimeoutMs: services.config.guard.estimateTimeoutMs,
    });

    // Query Guard enforce: estimate (reusing a fresh cached estimate from a
    // just-prior /estimate call so this is usually a no-op) and block before
    // any execution when the verdict says so.
    // enforce モードの時だけ、実行前にもう一度見積りを取り block 判定なら実行させずエラーにする。
    // 見積りサービス側に TTL キャッシュがあるため、直前の /estimate 呼び出しと同一なら
    // Trino への追加問い合わせは実質発生しない。
    if (effective.mode === 'enforce') {
      // costEstimate 非対応エンジン(mysql/postgresql)は見積りをスキップして実行へ進む。
      if (engine.capabilities.costEstimate) {
        const estimate = await services.estimate.estimate({
          statement: body.statement,
          catalog,
          schema,
          principal: principal.user,
          datasourceId: body.datasourceId,
          roleName: principal.role.name,
          guard: effective,
        });
        if (estimate.verdict.decision === 'block') {
          throw AppError.queryBlocked(
            estimate.verdict.reasons[0] ?? 'Query blocked by Query Guard',
            {
              estimate,
              limits: effectiveGuardLimitsSnapshot(services.config, principal.role),
            },
          );
        }
      }
    }

    const overflowMode: OverflowMode | undefined =
      body.maxRows !== undefined ? services.config.query.overflowMode : undefined;
    const maxRows = effectiveMaxRows(body.maxRows, services.config.query.maxRows);
    let persistResult = true;
    if (services.githubGovernance.enabled) {
      persistResult = await services.githubGovernance.isStatementApproved(body.statement);
    }
    // 実行そのものは services.queries（実行レジストリ）に委譲し、ここでは queryId だけ返す。
    const exec = services.queries.submit({
      statement: body.statement,
      ctx,
      owner: principal.user,
      datasourceId: body.datasourceId,
      sessionReadOnly: !hasQueryWrite(principal.role),
      roleName: principal.role.name,
      maxRows,
      overflowMode,
      notebookId: body.notebookId,
      cellId: body.cellId,
      persistResult,
    });
    await services.audit.record({
      actor: principal.user,
      action: 'query.execute',
      target: exec.queryId,
      datasource: queryDatasourceId,
      detail: {
        catalog: catalog ?? null,
        schema: schema ?? null,
        role: principal.role.name,
        notebookId: body.notebookId ?? null,
        cellId: body.cellId ?? null,
        maxRows: maxRows ?? null,
        hasSessionProperties: Object.keys(body.sessionProperties ?? {}).length > 0,
      },
    });
    return c.json({ queryId: exec.queryId }, 202);
  });

  /**
   * Fetch an execution scoped to the requesting principal. A query is owned by
   * the principal whose impersonation user started it; another
   * user gets a 404 (indistinguishable from "unknown id"), so executions never
   * leak across owners.
   *
   * `:id` を取るエンドポイント共通の「実行を取得し、所有者チェックする」ヘルパー。
   * 存在しない id は `registry.getOrThrow` が例外を投げ、存在するが別ユーザー所有の場合は
   * ここで明示的に 404 を投げる。両者を区別できないようにするのが意図（IDOR 対策）。
   */
  const ownedExec = (c: { req: { param: (k: string) => string }; var: AuthVariables }) => {
    const exec = services.registry.getOrThrow(c.req.param('id'));
    if (exec.ctx.user !== undefined && exec.ctx.user !== c.var.principal.user) {
      throw AppError.notFound(`Query ${c.req.param('id')} not found`);
    }
    return exec;
  };

  const maybeOwnedExec = (
    id: string,
    c: { var: AuthVariables },
  ): ReturnType<typeof services.registry.get> => {
    const exec = services.registry.get(id);
    if (!exec) return undefined;
    if (exec.ctx.user !== undefined && exec.ctx.user !== c.var.principal.user) {
      throw AppError.notFound(`Query ${id} not found`);
    }
    return exec;
  };

  const usablePersistedResult = async (
    c: { req: { param: (k: string) => string }; var: AuthVariables },
    opts: { optional?: boolean } = {},
  ): Promise<HistoryResultRef | undefined> => {
    const id = c.req.param('id');
    const ref = await services.history.getResultRef(c.var.principal.user, id);
    if (!ref) {
      if (opts.optional) return undefined;
      throw AppError.notFound(`Query ${id} not found`);
    }
    if (new Date(ref.resultExpiresAt).getTime() <= Date.now()) {
      if (opts.optional) return undefined;
      throw AppError.notFound(`Query ${id} not found`);
    }
    requireDatasourceAccess(c.var.principal.role, ref.datasourceId);
    return ref;
  };

  const requirePersistedResult = async (c: {
    req: { param: (k: string) => string };
    var: AuthVariables;
  }): Promise<HistoryResultRef> => {
    const ref = await usablePersistedResult(c);
    if (!ref) throw AppError.notFound(`Query ${c.req.param('id')} not found`);
    return ref;
  };

  /** filter/sort の columnIndex が列数の範囲内か検証する。 */
  const assertResultSearchColumnIndices = (
    columns: readonly { name: string; type: string }[],
    request: ResultSearchRequest,
  ): void => {
    const columnCount = columns.length;
    const invalidIndices: number[] = [];
    for (const filter of request.filters ?? []) {
      if (filter.columnIndex >= columnCount) invalidIndices.push(filter.columnIndex);
    }
    if (request.sort && request.sort.columnIndex >= columnCount) {
      invalidIndices.push(request.sort.columnIndex);
    }
    if (invalidIndices.length === 0) return;
    throw AppError.badRequest(
      `columnIndex out of range: ${[...new Set(invalidIndices)].join(', ')} (column count: ${columnCount})`,
      'VALIDATION_ERROR',
    );
  };

  const resolveExportEvents = async (
    c: { req: { param: (k: string) => string }; var: AuthVariables },
    exec: ReturnType<typeof services.registry.get> | undefined,
  ): Promise<{
    events: AsyncGenerator<QueryResultEvent>;
    source: QueryResultEventSource;
    target: string;
    datasourceId: string;
    rowCount?: number;
  }> => {
    const id = c.req.param('id');
    const principal = c.var.principal;
    const persisted = await usablePersistedResult(c, { optional: exec !== undefined });
    if (persisted) {
      return {
        events: streamPersistedResultEvents(
          await services.resultStore.getStream(persisted.resultObjectKey),
        ),
        source: 'resultStore',
        target: persisted.id,
        datasourceId: persisted.datasourceId,
        rowCount: persisted.rowCount,
      };
    }
    if (!exec) throw AppError.notFound(`Query ${id} not found`);

    const needsReexec = needsCsvReexec(exec);
    const allowsReexec = statementAllowsCsvReexec(exec);
    if (needsReexec && allowsReexec && exec.engine.isClosed()) {
      throw AppError.csvReexecUnavailable(
        'Full export requires re-execution but the original datasource connection is no longer available.',
      );
    }

    if (needsReexec && allowsReexec) {
      requireDatasourceAccess(principal.role, exec.datasourceId);
      const catalog = exec.ctx.catalog ?? services.config.defaults.catalog;
      const schema = exec.ctx.schema ?? services.config.defaults.schema;
      const ioExplain = exec.engine.ioExplainExecution?.({
        statement: exec.statement,
        catalog,
        schema,
        principal: principal.user,
      });
      await assertQueryWriteAllowed({
        statement: exec.statement,
        role: principal.role,
        ioExplainClient: ioExplain?.client,
        ioExplainCtx: ioExplain?.ctx,
        ioExplainTimeoutMs: services.config.guard.estimateTimeoutMs,
      });
    }

    const resolved = streamQueryResultEvents(exec, {
      downloadClientOptions: {
        user: exec.ctx.user,
        roleName: principal.role.name,
        sessionReadOnly: !hasQueryWrite(principal.role),
      },
    });
    return {
      events: resolved.events,
      source: resolved.source,
      target: exec.queryId,
      datasourceId: exec.datasourceId,
      rowCount: exec.isTerminal ? exec.rowCount : undefined,
    };
  };

  const recordExportDenied = async (input: {
    actor: string;
    action: AuditAction;
    target?: string;
    datasource?: string;
    err: unknown;
  }): Promise<void> => {
    await services.audit.record({
      actor: input.actor,
      action: input.action,
      target: input.target,
      datasource: input.datasource,
      detail: buildExportDeniedDetail(input.err),
    });
  };

  // GET /api/queries/:id — snapshot.
  // 実行の現在状態（ステータス、行数、エラー等）をポーリング取得するためのスナップショット API。
  app.get('/:id', async (c) => {
    const exec = maybeOwnedExec(c.req.param('id'), c);
    if (exec) return c.json(exec.snapshot());

    const ref = await requirePersistedResult(c);
    const metadata = await readPersistedResultMetadata(
      await services.resultStore.getStream(ref.resultObjectKey),
    );
    const snapshot: QuerySnapshot = {
      queryId: ref.id,
      state: ref.state,
      rowCount: ref.rowCount,
      truncated: false,
      submittedAt: ref.submittedAt,
      datasourceId: ref.datasourceId,
      csvReexecAllowed: false,
    };
    if (ref.trinoQueryId) snapshot.trinoQueryId = ref.trinoQueryId;
    if (ref.errorMessage) snapshot.error = { code: 'QUERY_ERROR', message: ref.errorMessage };
    if (metadata.columns.length > 0) snapshot.columns = metadata.columns;
    return c.json(snapshot);
  });

  // GET /api/queries/:id/rows?offset&limit — page of buffered rows.
  // バッファ済みの結果行をオフセット/リミット指定でページングして返す。
  app.get('/:id/rows', async (c) => {
    const exec = maybeOwnedExec(c.req.param('id'), c);
    const offset = intParam(c.req.query('offset'), 0);
    // limit は 1〜10,000 の範囲にクランプし、過大なリクエストでメモリを圧迫しないようにする。
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 100), 1), 10_000);
    if (!exec) {
      const ref = await requirePersistedResult(c);
      const persisted = await readPersistedRowsPage(
        await services.resultStore.getStream(ref.resultObjectKey),
        Math.max(offset, 0),
        limit,
      );
      const page: QueryRowsPage = {
        offset: Math.max(offset, 0),
        rows: persisted.rows,
        totalBuffered: persisted.totalRows,
        complete: true,
      };
      return c.json(page);
    }
    const page: QueryRowsPage = {
      offset,
      rows: exec.getRows(offset, limit),
      totalBuffered: exec.bufferedCount,
      complete: exec.isTerminal,
    };
    return c.json(page);
  });

  // POST /api/queries/:id/rows/search — filter / sort / search over buffered or persisted rows.
  // メモリバッファまたは永続化結果の行をストリーミング評価して server-side 探索を行う。
  // 永続化結果は QUERY_MAX_ROWS で有界ではないため、全行を配列へ materialize しない。
  app.post('/:id/rows/search', async (c) => {
    const body = await parseJsonBody(c, resultSearchRequestSchema);
    // 保持行数の上限は offset + limit に比例するため、窓の上限を検証する
    //（詳細は exploration.ts の RESULT_SEARCH_MAX_WINDOW のコメント参照）。
    if (body.offset + body.limit > RESULT_SEARCH_MAX_WINDOW) {
      throw AppError.badRequest(
        `offset + limit must not exceed ${RESULT_SEARCH_MAX_WINDOW}`,
        'VALIDATION_ERROR',
      );
    }
    const exec = maybeOwnedExec(c.req.param('id'), c);
    if (!exec) {
      const ref = await requirePersistedResult(c);
      const cursor = await openPersistedResult(
        await services.resultStore.getStream(ref.resultObjectKey),
      );
      assertResultSearchColumnIndices(cursor.columns, body);
      const searched = await searchRowsStream(cursor.columns, cursor.rows, body);
      const page: ResultSearchPage = {
        offset: body.offset,
        rows: searched.rows,
        totalMatched: searched.totalMatched,
        totalRows: searched.totalRows,
        complete: true,
      };
      return c.json(page);
    }
    const columns = exec.snapshot().columns ?? [];
    assertResultSearchColumnIndices(columns, body);
    // メモリバッファは QUERY_MAX_ROWS で有界なので、そのまま同期 Iterable として渡す。
    const searched = await searchRowsStream(columns, exec.getRows(0, exec.bufferedCount), body);
    const page: ResultSearchPage = {
      offset: body.offset,
      rows: searched.rows,
      totalMatched: searched.totalMatched,
      totalRows: exec.bufferedCount,
      complete: exec.isTerminal,
    };
    return c.json(page);
  });

  // GET /api/queries/:id/profile — column profiles over buffered or persisted rows.
  // メモリバッファまたは永続化結果の行をストリーミング走査して列プロファイルを計算する。
  app.get('/:id/profile', async (c) => {
    const exec = maybeOwnedExec(c.req.param('id'), c);
    if (!exec) {
      const ref = await requirePersistedResult(c);
      const cursor = await openPersistedResult(
        await services.resultStore.getStream(ref.resultObjectKey),
      );
      const profiled = await profileRowsStream(cursor.columns, cursor.rows);
      const profile: ResultProfile = {
        rowCount: profiled.rowCount,
        complete: true,
        columns: profiled.profiles,
      };
      return c.json(profile);
    }
    const columns = exec.snapshot().columns ?? [];
    const profiled = await profileRowsStream(columns, exec.getRows(0, exec.bufferedCount));
    const profile: ResultProfile = {
      rowCount: exec.bufferedCount,
      complete: exec.isTerminal,
      columns: profiled.profiles,
    };
    return c.json(profile);
  });

  // DELETE /api/queries/:id — cancel.
  // 実行中のクエリをキャンセルする。Trino 側へのキャンセル要求とローカル状態更新は exec に委譲。
  app.delete('/:id', async (c) => {
    const exec = ownedExec(c);
    await exec.requestCancel();
    return c.json(exec.snapshot());
  });

  // GET /api/queries/:id/events — SSE replay + live.
  // Server-Sent Events でクエリの進捗をリアルタイム配信するエンドポイント。
  // 接続直後に「これまでの状態のリプレイ」を送り、その後はライブイベントをそのまま流す。
  app.get('/:id/events', (c) => {
    const exec = ownedExec(c);
    return streamSSE(c, async (sseStream) => {
      // Buffer live events that arrive during replay, then flush in order.
      // リプレイ処理中に発生したライブイベントを取りこぼさないよう、いったんバッファに退避する。
      const pending: string[] = [];
      let replaying = true;
      const unsubscribe = exec.subscribe((event) => {
        const frame = encodeSseEvent(event);
        if (replaying) {
          pending.push(frame);
        } else {
          void sseStream.write(frame);
        }
      });

      // クエリが既に終端状態なら即座に解決し、そうでなければ settled の完了を待つ Promise。
      const done = new Promise<void>((resolve) => {
        if (exec.isTerminal) resolve();
        else void exec.settled.then(resolve);
      });

      // 中間プロキシ等によるアイドルタイムアウトで接続が切られないよう、定期的に keepalive を送る。
      const keepAlive = setInterval(() => {
        void sseStream.write(SSE_KEEPALIVE);
      }, KEEPALIVE_INTERVAL_MS);

      // クライアント切断時は keepalive タイマーと購読を確実に解除してリークを防ぐ。
      sseStream.onAbort(() => {
        clearInterval(keepAlive);
        unsubscribe();
      });

      try {
        // Replay current state snapshot.
        // 接続時点までの状態を再構築したイベント列を先に流す（新規購読者への状態同期）。
        for (const event of buildReplayEvents(exec)) {
          await sseStream.write(encodeSseEvent(event));
        }
        // Flush events that arrived during replay, then go live.
        // リプレイ中に溜まったイベントを送信してからライブモードへ切り替える。
        replaying = false;
        for (const frame of pending) {
          await sseStream.write(frame);
        }
        pending.length = 0;

        // Wait for the query to settle (live events flow via the subscriber).
        // 以降のイベントは上の subscribe コールバックが直接 write するので、ここでは完了を待つだけ。
        await done;
      } finally {
        clearInterval(keepAlive);
        unsubscribe();
      }
    });
  });

  // GET /api/queries/:id/download.csv?compression=gzip|zip
  // 結果全体を CSV としてストリーミングダウンロードするエンドポイント。無圧縮/gzip/zip を選択可能。
  app.get('/:id/download.csv', async (c) => {
    const id = c.req.param('id');
    const exec = maybeOwnedExec(id, c);
    const principal = c.var.principal;
    const compression = c.req.query('compression');
    const gzip = compression === 'gzip';
    const zip = compression === 'zip';
    const csvName = `${id}.csv`;
    const filename = zip ? `${id}.zip` : `${csvName}${gzip ? '.gz' : ''}`;

    const persisted = await usablePersistedResult(c, { optional: exec !== undefined });
    if (persisted) {
      await services.audit.record({
        actor: principal.user,
        action: 'csv.download',
        target: persisted.id,
        datasource: persisted.datasourceId,
        detail: {
          compression: zip ? 'zip' : gzip ? 'gzip' : 'none',
          source: 'resultStore',
          outcome: 'allowed',
        },
      });
      c.header('Content-Type', zip ? 'application/zip' : 'text/csv; charset=utf-8');
      c.header('Content-Disposition', `attachment; filename="${filename}"`);
      if (gzip) c.header('Content-Encoding', 'gzip');
      c.header('Cache-Control', 'no-store');

      return stream(c, async (rawStream) => {
        const ac = new AbortController();
        rawStream.onAbort(() => ac.abort());
        const csv = streamPersistedCsv(
          await services.resultStore.getStream(persisted.resultObjectKey),
        );
        await writeCsvDownload(rawStream, csvName, csv, { zip, gzip, signal: ac.signal });
      });
    }

    if (!exec) throw AppError.notFound(`Query ${id} not found`);

    const engine = exec.engine;
    const catalog = exec.ctx.catalog ?? services.config.defaults.catalog;
    const schema = exec.ctx.schema ?? services.config.defaults.schema;
    const needsReexec = needsCsvReexec(exec);
    const allowsReexec = statementAllowsCsvReexec(exec);
    const csvAuditDetail = {
      compression: zip ? 'zip' : gzip ? 'gzip' : 'none',
      needsReexec,
      allowsReexec,
      truncated: exec.truncated,
    } as const;

    if (needsReexec && allowsReexec && exec.engine.isClosed()) {
      await services.audit.record({
        actor: principal.user,
        action: 'csv.download',
        target: exec.queryId,
        datasource: exec.datasourceId,
        detail: {
          ...csvAuditDetail,
          outcome: 'denied',
          reason: 'csvReexecUnavailable',
          errorCode: CSV_REEXEC_UNAVAILABLE,
        },
      });
      throw AppError.csvReexecUnavailable(
        'Full CSV download requires re-execution but the original datasource connection is no longer available.',
      );
    }

    if (needsReexec && allowsReexec) {
      requireDatasourceAccess(principal.role, exec.datasourceId);
      const ioExplain = engine.ioExplainExecution?.({
        statement: exec.statement,
        catalog,
        schema,
        principal: principal.user,
      });
      await assertQueryWriteAllowed({
        statement: exec.statement,
        role: principal.role,
        ioExplainClient: ioExplain?.client,
        ioExplainCtx: ioExplain?.ctx,
        ioExplainTimeoutMs: services.config.guard.estimateTimeoutMs,
      });
    }

    if (needsReexec && !allowsReexec) {
      c.header(CSV_REEXEC_HEADER, 'unavailable');
      if (exec.truncated) c.header(CSV_TRUNCATED_HEADER, 'true');
    }

    await services.audit.record({
      actor: principal.user,
      action: 'csv.download',
      target: exec.queryId,
      datasource: exec.datasourceId,
      detail: {
        ...csvAuditDetail,
        outcome: 'allowed',
      },
    });

    c.header('Content-Type', zip ? 'application/zip' : 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (gzip) c.header('Content-Encoding', 'gzip');
    c.header('Cache-Control', 'no-store');

    return stream(c, async (rawStream) => {
      // Abort signal drives both the response and the (possible) Trino re-run,
      // so a client disconnect tears the download query down.
      // AbortController でレスポンスストリームと Trino 側の再実行（結果が失効している場合の
      // 再クエリ）の両方を同時に打ち切れるようにする。
      const ac = new AbortController();
      rawStream.onAbort(() => ac.abort());
      const csv = streamQueryCsv(exec, {
        downloadClientOptions: {
          user: exec.ctx.user,
          roleName: principal.role.name,
          sessionReadOnly: !hasQueryWrite(principal.role),
        },
        signal: ac.signal,
      });

      if (zip) {
        await pipeZip(rawStream, csvName, csv, ac.signal);
      } else if (gzip) {
        // Pipe CSV text through a gzip CompressionStream.
        // Web標準の CompressionStream を使い、CSV テキストを都度 gzip 圧縮しながら書き出す。
        const gz = new CompressionStream('gzip');
        const writer = gz.writable.getWriter();
        const encoder = new TextEncoder();
        const pumped = rawStream.pipe(gz.readable);
        try {
          for await (const chunk of csv) {
            if (ac.signal.aborted) break;
            await writer.write(encoder.encode(chunk));
          }
        } finally {
          await writer.close();
          await pumped;
        }
      } else {
        // 非圧縮: CSV テキストのチャンクをそのままレスポンスへ書き出す。
        for await (const chunk of csv) {
          if (ac.signal.aborted) break;
          await rawStream.write(chunk);
        }
      }
    });
  });

  // GET /api/queries/:id/download.xlsx
  // CSV と同じ行ソースを使い、Excel xlsx としてストリーミングダウンロードする。
  app.get('/:id/download.xlsx', async (c) => {
    const id = c.req.param('id');
    const exec = maybeOwnedExec(id, c);
    const principal = c.var.principal;
    let resolved: Awaited<ReturnType<typeof resolveExportEvents>>;
    try {
      resolved = await resolveExportEvents(c, exec);
      assertXlsxLimit(resolved.rowCount);
    } catch (err) {
      await recordExportDenied({
        actor: principal.user,
        action: 'export.xlsx',
        target: exec?.queryId ?? id,
        datasource: exec?.datasourceId,
        err,
      });
      throw err;
    }

    await services.audit.record({
      actor: principal.user,
      action: 'export.xlsx',
      target: resolved.target,
      datasource: resolved.datasourceId,
      detail: {
        outcome: 'allowed',
        source: resolved.source,
        delivery: 'download',
      },
    });

    c.header('Content-Type', XLSX_CONTENT_TYPE);
    c.header('Content-Disposition', `attachment; filename="${id}.xlsx"`);
    c.header('Cache-Control', 'no-store');
    return stream(c, async (rawStream) => {
      const ac = new AbortController();
      rawStream.onAbort(() => ac.abort());
      const xlsx = new PassThrough();
      const writer = writeXlsx(resolved.events, xlsx).catch((err) => {
        xlsx.destroy(err instanceof Error ? err : new Error(String(err)));
        throw err;
      });
      await Promise.all([pipeNodeReadable(rawStream, xlsx, ac.signal), writer]);
    });
  });

  // POST /api/queries/:id/export
  // クエリ結果を S3 または Google Sheets へ同期的にエクスポートする。
  app.post('/:id/export', async (c) => {
    const body = await parseJsonBody(c, queryExportRequestSchema);
    const id = c.req.param('id');
    const exec = maybeOwnedExec(id, c);
    const principal = c.var.principal;
    const auditAction = body.destination === 's3' ? 'export.s3' : 'export.sheets';
    let resolved: Awaited<ReturnType<typeof resolveExportEvents>> | undefined;

    try {
      resolved = await resolveExportEvents(c, exec);
      if (body.destination === 's3') {
        if (body.format === 'xlsx') assertXlsxLimit(resolved.rowCount);
        const response = await exportToS3({
          config: services.config.export.s3,
          request: body,
          owner: principal.user,
          queryId: id,
          events: resolved.events,
          now: new Date(),
        });
        await services.audit.record({
          actor: principal.user,
          action: 'export.s3',
          target: resolved.target,
          datasource: resolved.datasourceId,
          detail: {
            outcome: 'allowed',
            source: resolved.source,
            format: response.format,
            gzip: response.gzip ?? false,
            objectKey: response.objectKey,
          },
        });
        return c.json(queryExportResponseSchema.parse(response));
      }

      const response = await exportToSheets({
        config: services.config.export.sheets,
        email: principal.email,
        queryId: id,
        events: resolved.events,
      });
      await services.audit.record({
        actor: principal.user,
        action: 'export.sheets',
        target: resolved.target,
        datasource: resolved.datasourceId,
        detail: {
          outcome: 'allowed',
          source: resolved.source,
          spreadsheetId: response.spreadsheetId,
        },
      });
      return c.json(queryExportResponseSchema.parse(response));
    } catch (err) {
      await services.audit.record({
        actor: principal.user,
        action: auditAction,
        target: resolved?.target ?? exec?.queryId ?? id,
        datasource: resolved?.datasourceId ?? exec?.datasourceId,
        detail: buildExportDeniedDetail(err),
      });
      throw err;
    }
  });

  return app;
}

/**
 * Stream a single-entry DEFLATE zip to the HTTP response. The CSV text generator
 * is fed into yazl as a Node Readable (constant memory: yazl deflates and emits
 * compressed chunks as input arrives); yazl's compressed output stream is pumped
 * to Hono's `StreamingApi`. The whole CSV is never held in memory.
 *
 * CSV 生成ジェネレータを 1 エントリの zip（DEFLATE 圧縮）としてストリーミングし、
 * HTTP レスポンスへ直接書き出す内部ヘルパー。CSV 全体をメモリに保持しない点が重要。
 * @param out - 書き込み先の Hono `StreamingApi`。
 * @param entryName - zip 内のエントリ名（ダウンロードファイル名相当）。
 * @param csv - CSV テキストを逐次生成する非同期ジェネレータ。
 * @param signal - クライアント切断等での中断を伝える AbortSignal。
 */
async function pipeZip(
  out: StreamingApi,
  entryName: string,
  csv: AsyncGenerator<string>,
  signal: AbortSignal,
): Promise<void> {
  const zip = new ZipFile();
  const source = Readable.from(csvBytes(csv, signal));
  // mtime fixed so output is deterministic; size unknown -> streaming entry.
  zip.addReadStream(source, entryName, { compress: true, mtime: new Date(0) });
  zip.end();

  try {
    for await (const chunk of zip.outputStream as AsyncIterable<Buffer>) {
      if (signal.aborted) break;
      await out.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  } finally {
    // If we bailed early, drain the CSV generator's cleanup (Trino cancel).
    // 中断時は Readable と CSV ジェネレータの後始末を行い、Trino 側の実行キャンセルを確実にする。
    if (signal.aborted) {
      source.destroy();
      await csv.return(undefined).catch(() => {});
    }
  }
}

/**
 * UTF-8 encode each CSV text chunk for yazl, stopping early on abort.
 *
 * CSV テキストチャンクを UTF-8 バイト列へ変換して yazl に渡すためのアダプタジェネレータ。
 * @param csv - CSV テキストを逐次生成する非同期ジェネレータ。
 * @param signal - 中断を伝える AbortSignal。中断時は残りのチャンクを生成せず終了する。
 */
async function* csvBytes(csv: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<Buffer> {
  const encoder = new TextEncoder();
  for await (const chunk of csv) {
    if (signal.aborted) return;
    yield Buffer.from(encoder.encode(chunk));
  }
}

// Re-export so app.ts can register a not-found that throws AppError consistently.
// app.ts の not-found ハンドラが同じ AppError 型でエラーを投げられるよう、ここから再エクスポートする。
export { AppError };

async function writeCsvDownload(
  rawStream: StreamingApi,
  csvName: string,
  csv: AsyncGenerator<string>,
  options: { zip: boolean; gzip: boolean; signal: AbortSignal },
): Promise<void> {
  if (options.zip) {
    await pipeZip(rawStream, csvName, csv, options.signal);
    return;
  }
  if (options.gzip) {
    const gz = new CompressionStream('gzip');
    const writer = gz.writable.getWriter();
    const encoder = new TextEncoder();
    const pumped = rawStream.pipe(gz.readable);
    try {
      for await (const chunk of csv) {
        if (options.signal.aborted) break;
        await writer.write(encoder.encode(chunk));
      }
    } finally {
      await writer.close();
      await pumped;
    }
    return;
  }
  for await (const chunk of csv) {
    if (options.signal.aborted) break;
    await rawStream.write(chunk);
  }
}

function assertXlsxLimit(rowCount: number | undefined): void {
  if (rowCount === undefined || rowCount <= XLSX_MAX_DATA_ROWS) return;
  throw new AppError(413, {
    code: 'RESULT_TOO_LARGE',
    message:
      'xlsx export is limited to 1,048,576 worksheet rows. Use CSV export for larger results.',
  });
}

function buildExportDeniedDetail(err: unknown): Record<string, string> {
  if (err instanceof AppError) {
    return {
      outcome: 'denied',
      errorCode: err.detail.code,
      error: err.detail.message,
    };
  }
  return {
    outcome: 'denied',
    error: err instanceof Error ? err.message : String(err),
  };
}

async function pipeNodeReadable(
  rawStream: StreamingApi,
  source: Readable,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const chunk of source) {
      if (signal.aborted) break;
      const buffer =
        chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));
      await rawStream.write(buffer);
    }
  } finally {
    if (signal.aborted) source.destroy();
  }
}

async function exportToS3(input: {
  config: ExportConfig['s3'];
  request: Extract<QueryExportRequest, { destination: 's3' }>;
  owner: string;
  queryId: string;
  events: AsyncGenerator<QueryResultEvent>;
  now: Date;
}): Promise<Extract<QueryExportResponse, { destination: 's3' }>> {
  const gzip = input.request.format === 'csv' && input.request.gzip === true;
  const extension = input.request.format === 'xlsx' ? 'xlsx' : gzip ? 'csv.gz' : 'csv';
  const key = buildExportObjectKey({
    prefix: input.config.prefix,
    owner: input.owner,
    queryId: input.queryId,
    timestamp: input.now,
    extension,
  });
  const uploader = new S3ExportUploader(input.config);
  await uploader.upload({
    key,
    contentType: input.request.format === 'xlsx' ? XLSX_CONTENT_TYPE : 'text/csv; charset=utf-8',
    contentEncoding: gzip ? 'gzip' : undefined,
    bodyWriter: async (stream) => {
      if (input.request.format === 'xlsx') {
        await writeXlsx(input.events, stream);
        return;
      }
      await writeCsvEvents(input.events, stream, { gzip });
    },
  });
  return {
    destination: 's3',
    objectKey: key,
    format: input.request.format,
    ...(gzip ? { gzip } : {}),
  };
}

async function exportToSheets(input: {
  config: ExportConfig['sheets'];
  email?: string;
  queryId: string;
  events: AsyncGenerator<QueryResultEvent>;
}): Promise<Extract<QueryExportResponse, { destination: 'sheets' }>> {
  const exporter = new SheetsExporter(input.config);
  const result = await exporter.export({
    title: `Hubble ${input.queryId}`,
    email: input.email,
    events: input.events,
  });
  return {
    destination: 'sheets',
    spreadsheetId: result.spreadsheetId,
    url: result.url,
  };
}

async function writeCsvEvents(
  events: AsyncGenerator<QueryResultEvent>,
  stream: PassThrough,
  options: { gzip: boolean },
): Promise<void> {
  const destination = options.gzip ? createGzip() : stream;
  if (options.gzip) destination.pipe(stream);
  try {
    for await (const chunk of csvFromEvents(events)) {
      if (!destination.write(chunk)) {
        await new Promise((resolve) => destination.once('drain', resolve));
      }
    }
  } finally {
    destination.end();
  }
}

async function* csvFromEvents(events: AsyncGenerator<QueryResultEvent>): AsyncGenerator<string> {
  let headerWritten = false;
  for await (const event of events) {
    if (event.type === 'columns') {
      if (event.columns.length > 0)
        yield `${csvRecord(event.columns.map((column) => column.name))}\r\n`;
      headerWritten = true;
      continue;
    }
    if (!headerWritten) headerWritten = true;
    yield `${csvRecord(event.row)}\r\n`;
  }
}

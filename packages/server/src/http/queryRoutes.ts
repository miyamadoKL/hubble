/**
 * クエリ実行 API ルーター（`packages/server/src/http/queryRoutes.ts`）。
 *
 * design.md §7 が定義する「クエリ」まわりのエンドポイント群（見積り(estimate) / 投入(submit) /
 * スナップショット取得 / 行ページ取得 / キャンセル /
 * SSE によるライブ進捗配信 / CSV ダウンロード）を Hono のサブルーターとして実装する。
 *
 * このファイルは BFF (packages/server) の HTTP 層に属し、HTTP リクエストの解析、
 * オーナースコープ認可（実行したユーザー以外からは 404 にする）、レスポンス整形のみを担当する。
 * 実際の Trino 通信、実行状態の保持、Query Guard の判定ロジックなどは `services` 経由で
 * `../query/execution` や `../query/guard`、`../query/sse`、`../query/csv` に委譲する。
 * `app.ts` から `app.route('/api/queries', queryRoutes(services))` としてマウントされる。
 */
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { stream } from 'hono/streaming';
import type { StreamingApi } from 'hono/utils/stream';
import {
  createQueryRequestSchema,
  estimateRequestSchema,
  type QueryRowsPage,
} from '@hubble/contracts';
import type { Services } from '../services';
import { resolveEngine } from '../engine/resolve';
import type { TrinoRequestContext } from '../trino/types';
import type { OverflowMode } from '../query/execution';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import { disabledEstimate, guardLimitsSnapshot } from '../query/guard';
import { intParam, parseJsonBody } from './validate';
import { buildReplayEvents, encodeSseEvent, SSE_KEEPALIVE } from '../query/sse';
import { streamQueryCsv } from '../query/csv';

// SSE 接続が生きていることをクライアント側の中間プロキシ等に伝えるための keepalive 送信間隔。
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Query endpoints (design.md §7): submit/snapshot/events(SSE)/rows/cancel/CSV.
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
    // mode=off: never touch Trino; return a `disabled` estimate immediately.
    // Query Guard 自体が無効な設定のときは Trino に問い合わせず即座に「無効」を返す。
    if (services.config.guard.mode === 'off') {
      return c.json(disabledEstimate());
    }
    const principal = c.var.principal;
    // 認証済み principal を渡すことで、Trino 側の EXPLAIN もそのユーザーとして impersonate される。
    const result = await services.estimate.estimate({
      statement: body.statement,
      catalog: body.catalog ?? services.config.defaults.catalog,
      schema: body.schema ?? services.config.defaults.schema,
      principal: principal.user,
      datasourceId: body.datasourceId,
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
    const ctx: TrinoRequestContext = {
      catalog,
      schema,
      source: body.source,
      // Impersonate the authenticated principal for this user query (design.md §11).
      user: principal.user,
      sessionProperties: body.sessionProperties,
    };

    // Query Guard enforce: estimate (reusing a fresh cached estimate from a
    // just-prior /estimate call so this is usually a no-op) and block before
    // any execution when the verdict says so.
    // enforce モードの時だけ、実行前にもう一度見積りを取り block 判定なら実行させずエラーにする。
    // 見積りサービス側に TTL キャッシュがあるため、直前の /estimate 呼び出しと同一なら
    // Trino への追加問い合わせは実質発生しない。
    if (services.config.guard.mode === 'enforce') {
      const estimate = await services.estimate.estimate({
        statement: body.statement,
        catalog,
        schema,
        principal: principal.user,
        datasourceId: body.datasourceId,
      });
      if (estimate.verdict.decision === 'block') {
        throw AppError.queryBlocked(estimate.verdict.reasons[0] ?? 'Query blocked by Query Guard', {
          estimate,
          limits: guardLimitsSnapshot(services.config),
        });
      }
    }

    const overflowMode: OverflowMode | undefined =
      body.maxRows !== undefined ? services.config.query.overflowMode : undefined;
    // 実行そのものは services.queries（実行レジストリ）に委譲し、ここでは queryId だけ返す。
    const exec = services.queries.submit({
      statement: body.statement,
      ctx,
      owner: principal.user,
      datasourceId: body.datasourceId,
      maxRows: body.maxRows,
      overflowMode,
      notebookId: body.notebookId,
      cellId: body.cellId,
    });
    return c.json({ queryId: exec.queryId }, 202);
  });

  /**
   * Fetch an execution scoped to the requesting principal. A query is owned by
   * the principal whose impersonation user started it (design.md §11); another
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

  // GET /api/queries/:id — snapshot.
  // 実行の現在状態（ステータス、行数、エラー等）をポーリング取得するためのスナップショット API。
  app.get('/:id', (c) => {
    const exec = ownedExec(c);
    return c.json(exec.snapshot());
  });

  // GET /api/queries/:id/rows?offset&limit — page of buffered rows.
  // バッファ済みの結果行をオフセット/リミット指定でページングして返す。
  app.get('/:id/rows', (c) => {
    const exec = ownedExec(c);
    const offset = intParam(c.req.query('offset'), 0);
    // limit は 1〜10,000 の範囲にクランプし、過大なリクエストでメモリを圧迫しないようにする。
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 100), 1), 10_000);
    const page: QueryRowsPage = {
      offset,
      rows: exec.getRows(offset, limit),
      totalBuffered: exec.bufferedCount,
      complete: exec.isTerminal,
    };
    return c.json(page);
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
  app.get('/:id/download.csv', (c) => {
    const exec = ownedExec(c);
    const compression = c.req.query('compression');
    const gzip = compression === 'gzip';
    const zip = compression === 'zip';
    const csvName = `${exec.queryId}.csv`;
    const filename = zip ? `${exec.queryId}.zip` : `${csvName}${gzip ? '.gz' : ''}`;

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
      const engine = resolveEngine(
        services.engines,
        exec.datasourceId,
        services.defaultDatasourceId,
      ).engine;
      const csv = streamQueryCsv(exec, {
        client: engine.downloadClient(exec.ctx.user),
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

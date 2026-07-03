/**
 * Trino 向け EXPLAIN (TYPE IO) 見積もりの実行ロジック。
 *
 * 旧 `estimateService.ts` の `run()` / `runExplain()` / `classifyError()` /
 * `buildResult()` を切り出したもの。`EstimateService` はキャッシュ層として
 * 残し、TrinoEngine がこのモジュールを再利用する。
 */
import type { EstimateResult, EstimateStatus } from '@hubble/contracts';
import { AppError, TrinoQueryError, TrinoTransportError } from '../errors';
import { parseExplainIoJson } from '../query/explainIo';
import { computeVerdict, type GuardLimits } from '../query/guardVerdict';
import type { StatementClient } from './types';
import type { TrinoRequestContext } from '../trino/types';
import { emptySessionMutations, type TrinoColumn } from '../trino/types';

/** 見積もり実行に必要な設定。 */
export interface TrinoEstimateOptions {
  client: StatementClient;
  metadataSource: string;
  estimateTimeoutMs: number;
  bytesPerSecond: number;
  limits: GuardLimits;
  now?: () => number;
}

/**
 * EXPLAIN (TYPE IO) を実行し EstimateResult を組み立てる。
 * @param statement - 見積もり対象の SQL。
 * @param ctx - Trino 実行コンテキスト。
 * @param options - クライアントと Guard 設定。
 * @returns 見積もり結果（キャッシュは呼び出し元の責務）。
 */
export async function runTrinoEstimate(
  statement: string,
  ctx: TrinoRequestContext,
  options: TrinoEstimateOptions,
): Promise<EstimateResult> {
  const now = options.now ?? Date.now;
  const start = now();
  let status: EstimateStatus;
  let parsed: ReturnType<typeof parseExplainIoJson>;
  try {
    const cell = await fetchTrinoIoExplainCell(
      statement,
      ctx,
      options.client,
      options.estimateTimeoutMs,
    );
    parsed = cell === undefined ? undefined : parseExplainIoJson(cell);
    // A missing cell or a non-IO-plan cell (Trino echoed an unsupported
    // statement verbatim) means the query cannot be estimated -> allow.
    // セルが存在しない、または IO プランでないセル（Trino が非対応の
    // ステートメントをそのままエコーバックした場合など）は「見積もり不能」
    // を意味し、ステータスは unsupported（=常に allow）となる。
    status = parsed ? 'estimated' : 'unsupported';
  } catch (err) {
    // EXPLAIN 自体が例外を投げた場合はエラー種別から状態を分類する。
    status = classifyEstimateError(err);
    parsed = undefined;
  }

  const elapsedMs = Math.max(now() - start, 0);
  return buildResult(status, parsed, elapsedMs, options);
}

// パース結果と状態から最終的な EstimateResult（verdict を含む）を組み立てる。
function buildResult(
  status: EstimateStatus,
  parsed: ReturnType<typeof parseExplainIoJson>,
  elapsedMs: number,
  options: TrinoEstimateOptions,
): EstimateResult {
  const scanBytes = parsed?.scanBytes ?? null;
  const scanRows = parsed?.scanRows ?? null;
  // guardVerdict.ts の純粋関数へ委譲して allow/warn/block を決定する。
  const verdict = computeVerdict({ status, scanBytes, scanRows }, options.limits);
  // 設定されたスループット（bytesPerSecond）からおおよその所要時間を概算する。
  const estimatedSeconds =
    options.bytesPerSecond > 0 && scanBytes !== null ? scanBytes / options.bytesPerSecond : null;
  return {
    status,
    scanBytes,
    scanRows,
    outputRows: parsed?.outputRows ?? null,
    outputBytes: parsed?.outputBytes ?? null,
    estimatedSeconds,
    tables: parsed?.tables ?? [],
    verdict,
    elapsedMs,
  };
}

/**
 * Map a thrown error to an estimate status:
 * - Trino USER_ERROR (syntax/analysis, EXPLAIN-unsupported): `unsupported`
 *   (the real run would fail immediately the same way — no resource risk).
 * - anything else (transport, timeout-abort, engine fault): `unavailable`.
 *
 * 投げられたエラーを見積もりステータスへマッピングする:
 * - Trino の USER_ERROR（構文/解析エラー、EXPLAIN 非対応など）は
 *   `unsupported` とする（実際にクエリを実行しても同様に即座に失敗する
 *   だけであり、リソースを消費するリスクは無いため）。
 * - それ以外（トランスポート障害、タイムアウトによる abort、エンジン側の
 *   障害など）はすべて `unavailable` とする。
 */
function classifyEstimateError(err: unknown): EstimateStatus {
  if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
    return 'unsupported';
  }
  if (err instanceof TrinoTransportError) return 'unavailable';
  // AbortError from the timeout, network failures, anything else -> unavailable.
  void (err instanceof AppError);
  return 'unavailable';
}

/**
 * Drive the EXPLAIN to completion, returning the single varchar cell, with a
 * hard timeout. On timeout the in-flight statement is cancelled (DELETE) and
 * the abort propagates so the run is torn down rather than left hanging.
 *
 * EXPLAIN 文を最後まで駆動し、単一の varchar セルを返す。ハードタイムアウト
 * 付きで、タイムアウト時は実行中のステートメントをキャンセル（DELETE）し、
 * abort を伝播させることで実行を宙ぶらりんにせず確実に後始末する。
 */
/**
 * EXPLAIN (TYPE IO, FORMAT JSON) を実行し JSON セルを返す（write check 等で再利用）。
 */
export async function fetchTrinoIoExplainCell(
  statement: string,
  ctx: TrinoRequestContext,
  client: StatementClient,
  timeoutMs: number,
): Promise<string | undefined> {
  const explain = `EXPLAIN (TYPE IO, FORMAT JSON) ${statement}`;
  return runExplain(explain, ctx, client, timeoutMs);
}

async function runExplain(
  statement: string,
  ctx: TrinoRequestContext,
  client: StatementClient,
  timeoutMs: number,
): Promise<string | undefined> {
  const ac = new AbortController();
  // estimateTimeoutMs 経過で強制的に abort する安全弁。
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const mutations = emptySessionMutations();
  let currentNextUri: string | undefined;
  try {
    // execution.ts の run() と同様のポーリングループ（開始 -> nextUri を
    // 辿って完了まで進める）。ただし EXPLAIN IO は 1 行 1 列しか返さないため
    // 行バッファは単純な配列に貯めるだけでよい。
    let page = await client.start(statement, ctx, mutations, ac.signal);
    let columns: TrinoColumn[] = page.columns ?? [];
    const rows: unknown[][] = [];
    if (page.data) rows.push(...page.data);

    let idleAttempt = 0;
    while (page.nextUri) {
      currentNextUri = page.nextUri;
      if (page.data && page.data.length > 0) {
        idleAttempt = 0;
      } else {
        await client.waitBackoff(idleAttempt, ac.signal);
        idleAttempt += 1;
      }
      page = await client.advance(page.nextUri, ctx, mutations, ac.signal);
      if (page.columns && columns.length === 0) columns = page.columns;
      if (page.data) rows.push(...page.data);
    }
    currentNextUri = undefined;
    // EXPLAIN IO returns exactly one row, one varchar column.
    // EXPLAIN IO は必ず 1 行 1 列（varchar）だけを返す仕様。
    const cell = rows[0]?.[0];
    return typeof cell === 'string' ? cell : undefined;
  } catch (err) {
    // Best-effort cancel of the in-flight EXPLAIN on timeout/abort.
    // タイムアウト/abort が原因の場合は、実行中の EXPLAIN をベストエフォートで
    // キャンセルしてから元の例外を再送出する。
    if (ac.signal.aborted && currentNextUri) {
      await client.cancel(currentNextUri, ctx);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

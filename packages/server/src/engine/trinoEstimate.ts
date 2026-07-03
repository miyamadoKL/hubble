/**
 * Trino 向け EXPLAIN (TYPE IO) 見積もりの実行ロジック。
 *
 * EstimateService から切り出し、TrinoEngine が再利用する。
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
  const explain = `EXPLAIN (TYPE IO, FORMAT JSON) ${statement}`;

  let status: EstimateStatus;
  let parsed: ReturnType<typeof parseExplainIoJson>;
  try {
    const cell = await runExplain(explain, ctx, options.client, options.estimateTimeoutMs);
    parsed = cell === undefined ? undefined : parseExplainIoJson(cell);
    status = parsed ? 'estimated' : 'unsupported';
  } catch (err) {
    status = classifyEstimateError(err);
    parsed = undefined;
  }

  const elapsedMs = Math.max(now() - start, 0);
  const scanBytes = parsed?.scanBytes ?? null;
  const scanRows = parsed?.scanRows ?? null;
  const verdict = computeVerdict({ status, scanBytes, scanRows }, options.limits);
  const estimatedSeconds =
    options.bytesPerSecond > 0 && scanBytes !== null
      ? scanBytes / options.bytesPerSecond
      : null;

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

function classifyEstimateError(err: unknown): EstimateStatus {
  if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
    return 'unsupported';
  }
  if (err instanceof TrinoTransportError) return 'unavailable';
  void (err instanceof AppError);
  return 'unavailable';
}

async function runExplain(
  statement: string,
  ctx: TrinoRequestContext,
  client: StatementClient,
  timeoutMs: number,
): Promise<string | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const mutations = emptySessionMutations();
  let currentNextUri: string | undefined;
  try {
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
    const cell = rows[0]?.[0];
    return typeof cell === 'string' ? cell : undefined;
  } catch (err) {
    if (ac.signal.aborted && currentNextUri) {
      await client.cancel(currentNextUri, ctx);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
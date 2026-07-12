import { emptySessionMutations, type TrinoRequestContext } from '../trino/types';
import type { StatementClient } from '../engine/types';
import type { AuditEventInput, AuditJson } from '../audit';
import { createSqlAbortError } from '../engine/sql/abort';

/**
 * このファイルは Query Scheduling 機能の「実行」ステップを担う `drainStatement` を
 * 提供する。scheduler.ts の attemptWithRetries() の検証とガードを通過した後、
 * 最終的にステートメントを Trino に投げて完走させるのはここ。通常のクエリ実行
 * (trino/registry.ts 等、SSE でクライアントへ結果をストリームする経路) とは異なり、
 * スケジュール実行は結果データを誰も見ないため、行データを溜め込まず件数だけを数える。
 */

export interface DrainResult {
  /** Trino's query id (`stats`-bearing response id). */
  trinoQueryId: string;
  /** Total rows produced by the statement (counted, not buffered). */
  rowCount: number;
}

export interface DrainStatementOptions {
  signal?: AbortSignal;
  audit?: {
    actor: string;
    target: string;
    datasource?: string;
    detail?: Record<string, AuditJson>;
    record: (event: AuditEventInput) => Promise<void>;
  };
}

/**
 * Run a statement to completion against Trino, counting result rows without
 * buffering them (Query Scheduling feature: a scheduled run records `row_count`
 * but never retains the data). Mirrors the client's backoff discipline used by
 * the streaming registry. Throws on any Trino error (the caller classifies it).
 */
export async function drainStatement(
  client: StatementClient,
  statement: string,
  ctx: TrinoRequestContext,
  options: DrainStatementOptions = {},
): Promise<DrainResult> {
  if (options.audit) {
    try {
      await options.audit.record({
        actor: options.audit.actor,
        action: 'schedule.execute',
        target: options.audit.target,
        datasource: options.audit.datasource,
        detail: options.audit.detail ?? {},
      });
    } catch (err) {
      // 監査ログの失敗でスケジュール本体を失敗させない。
      console.error('audit log write failed; continuing scheduled execution', err);
    }
  }
  throwIfAborted(options.signal);
  // 日本語: このスケジュール実行専用にセッションプロパティ等の変更を追跡する空の
  // mutations オブジェクトを用意する (結果を誰にも返さないため、変更内容自体は
  // 呼び出し元では使わないが client.start/advance のシグネチャ上必要)。
  const mutations = emptySessionMutations();
  let cancelUri: string | undefined;
  try {
    // POST /v1/statement で最初のページ (QUEUED) を取得。以降 nextUri を追走する。
    let page = await client.start(statement, ctx, mutations, options.signal);
    cancelUri = page.nextUri;
    throwIfAborted(options.signal);
    const trinoQueryId = page.id;
    let rowCount = page.data ? page.data.length : 0;

    // 日本語: idleAttempt は「データが来ないまま何回連続で追走したか」のカウンタ。
    // client.waitBackoff がこれを基に待ち時間を決める (データが来れば 0 にリセットし、
    // 来なければ増やして徐々に間隔を伸ばす) ことで、Trino への問い合わせ頻度を
    // 実行状況に応じて調整する。通常のストリーミング実行経路と同じ規律を踏襲。
    let idleAttempt = 0;
    while (page.nextUri) {
      cancelUri = page.nextUri;
      const hadData = page.data !== undefined && page.data.length > 0;
      if (hadData) {
        idleAttempt = 0;
      } else {
        await client.waitBackoff(idleAttempt, options.signal);
        throwIfAborted(options.signal);
        idleAttempt += 1;
      }
      // 次のページを取得し、行があれば件数だけ加算する (page.data 自体は破棄され、
      // rowCount 以外どこにも保持されない)。
      page = await client.advance(page.nextUri, ctx, mutations, options.signal);
      cancelUri = page.nextUri;
      throwIfAborted(options.signal);
      if (page.data) rowCount += page.data.length;
    }
    // nextUri が無くなった = FINISHED (または FAILED は例外で投げられ、ここには来ない)。
    return { trinoQueryId, rowCount };
  } catch (error) {
    if (options.signal?.aborted && cancelUri) {
      try {
        await client.cancel(cancelUri, ctx);
      } catch {
        // shutdown中は元のAbortを優先し、cancel失敗を上書きしない。
      }
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createSqlAbortError();
}

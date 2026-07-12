import { emptySessionMutations, type TrinoRequestContext } from '../trino/types';
import type { StatementClient } from '../engine/types';
import type { AuditEventInput, AuditJson } from '../audit';
import { createSqlAbortError } from '../engine/sql/abort';
import { driveStatementPages } from '../engine/statementDriver';

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
 *
 * ステートメントを完走させ、結果を保持せず行数だけを数える。
 * 通常のストリーミング実行と同じ backoff 規律を使い、エラーは呼び出し元へ渡す。
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
  // schedule はセッション変更を利用せず行も保持しない。共通 driver に空の
  // mutations を渡し、backoff、Abort、未完了 nextUri の解放だけを共有する。
  const mutations = emptySessionMutations();
  let trinoQueryId = '';
  let rowCount = 0;
  await driveStatementPages({
    client,
    statement,
    ctx,
    mutations,
    signal: options.signal,
    onPage: ({ page, first }) => {
      if (first) trinoQueryId = page.id;
      rowCount += page.data?.length ?? 0;
    },
  });
  return { trinoQueryId, rowCount };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createSqlAbortError();
}

/**
 * このファイルは `QueryRegistry`（実行管理）と `HistoryRepository`
 * （履歴永続化）を橋渡しする `QueryService` を提供する。
 *
 * 役割: クエリ提出時に `QueryRegistry.submit()` を呼んで `QueryExecution` を
 * 生成しつつ、同時にクエリ履歴（history）テーブルへ提出時点のスナップショット
 * を INSERT する。クエリが終端状態（finished/failed/canceled）に達したら、
 * 最終的な状態（rowCount、所要時間、エラーメッセージ等）で履歴行を UPDATE
 * する。履歴の記録はあくまで「ベストエフォート」であり、失敗してもクエリ
 * 実行そのものをブロックしたり失敗させたりしてはならない。
 *
 * アーキテクチャ上の位置づけ: HTTP ルート層（担当外）はクエリの提出時に
 * `QueryRegistry` を直接使わず、この `QueryService` を経由することで
 * 履歴記録が自動的に行われるようにする。実行のライフサイクル管理自体は
 * `QueryRegistry`/`QueryExecution` に委譲し、このクラスは履歴永続化の
 * 配線のみを担当する。
 */
import type { TrinoRequestContext } from '../trino/types';
import type { HistoryRepository } from '../store/history';
import type { OverflowMode } from './execution';
import { QueryExecution } from './execution';
import { QueryRegistry } from './registry';

/** `QueryService` の生成に必要な依存一式。 */
export interface QueryServiceParams {
  registry: QueryRegistry;
  history: HistoryRepository;
}

/** `submit()` に渡すクエリ提出パラメータ（履歴記録に必要な情報を含む）。 */
export interface SubmitQueryParams {
  statement: string;
  ctx: TrinoRequestContext;
  /** Owning principal — also the `X-Trino-User` (design.md §11). */
  // このクエリの所有者となる principal。Trino へのリクエストでは
  // `X-Trino-User` としても使われる（design.md §11 参照）。
  owner: string;
  datasourceId?: string;
  sessionReadOnly?: boolean;
  maxRows?: number;
  overflowMode?: OverflowMode;
  notebookId?: string;
  cellId?: string;
}

/**
 * Bridges the query registry and history persistence: records a history row on
 * submit and updates it when the query settles.
 *
 * クエリレジストリと履歴永続化を橋渡しするサービス。クエリ提出時に履歴行を
 * 記録し、クエリが終端状態に達した時点でその行を更新する。
 */
export class QueryService {
  constructor(private readonly params: QueryServiceParams) {}

  // 下位の QueryRegistry をそのまま公開する（HTTP ルート層が get/cancel 等
  // レジストリ固有の操作を直接呼べるようにするため）。
  get registry(): QueryRegistry {
    return this.params.registry;
  }

  /**
   * クエリを提出する。QueryRegistry へ実行を委譲しつつ、履歴テーブルへの
   * INSERT（提出時スナップショット）と、完了後の UPDATE（最終結果）を
   * fire-and-forget で配線する。呼び出し元へは QueryExecution を即座に返す
   * （履歴永続化の完了を待たない）。
   */
  submit(params: SubmitQueryParams): QueryExecution {
    const exec = this.params.registry.submit({
      statement: params.statement,
      ctx: params.ctx,
      datasourceId: params.datasourceId,
      sessionReadOnly: params.sessionReadOnly,
      maxRows: params.maxRows,
      overflowMode: params.overflowMode,
    });

    // Insert a history row immediately (state at submit time). History
    // persistence is best-effort and must not block or fail query submission,
    // so it runs fire-and-forget and the insert/update are ordered by chaining.
    // 提出時点の状態で履歴行を即座に INSERT する。履歴の永続化はあくまで
    // ベストエフォートであり、クエリの提出自体をブロックしたり失敗させたり
    // してはならないため、await せず fire-and-forget で実行する。
    // insert と update の実行順序は、update 側が `inserted` Promise を
    // 待ってから実行することで保証する（チェーンによる順序制御）。
    const inserted = this.params.history
      .insert({
        id: exec.queryId,
        statement: params.statement,
        catalog: params.ctx.catalog,
        schema: params.ctx.schema,
        state: exec.state,
        owner: params.owner,
        notebookId: params.notebookId,
        cellId: params.cellId,
        datasourceId: exec.datasourceId,
        submittedAt: new Date(exec.submittedAt).toISOString(),
      })
      .catch((err: unknown) => {
        // INSERT に失敗してもクエリ実行自体には影響させず、ログにのみ残す。
        console.error('failed to record query history (insert)', err);
      });

    // Update on settle (after the insert has been applied).
    // クエリが終端状態に達した（exec.settled が解決した）タイミングで、
    // かつ INSERT が完了していることを保証した上で、最終結果を UPDATE する。
    void Promise.all([inserted, exec.settled]).then(() => {
      const elapsedMs =
        exec.finishedAt !== undefined ? Math.max(exec.finishedAt - exec.submittedAt, 0) : 0;
      return this.params.history
        .update(exec.queryId, {
          state: exec.state,
          rowCount: exec.rowCount,
          elapsedMs,
          trinoQueryId: exec.trinoQueryId,
          errorMessage: exec.error?.message,
        })
        .catch((err: unknown) => {
          // UPDATE の失敗もログにのみ残し、呼び出し元には伝播させない。
          console.error('failed to record query history (update)', err);
        });
    });

    return exec;
  }
}

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
import type { AuditLogger } from '../audit';
import type { ResultStore } from '../resultStore';
import { ResultJsonlCapture } from '../resultStore/jsonl';
import {
  cleanupUnlinkedResultObject,
  type ResultObjectDeletionQueue,
} from '../resultStore/objectCleanup';
import type { OverflowMode, QueryResultObserver } from './execution';
import { QueryExecution } from './execution';
import { QueryRegistry } from './registry';

/** `QueryService` の生成に必要な依存一式。 */
export interface QueryServiceParams {
  registry: QueryRegistry;
  history: HistoryRepository;
  resultStore?: ResultStore;
  /** DB 未関連 object の削除を再試行する durable outbox。 */
  resultObjectDeletions: ResultObjectDeletionQueue;
  resultKeyPrefix?: string;
  resultTtlDays?: number;
  audit?: AuditLogger;
  logWarn?: (message: string, err?: unknown) => void;
  now?: () => number;
}

/** `submit()` に渡すクエリ提出パラメータ（履歴記録に必要な情報を含む）。 */
export interface SubmitQueryParams {
  statement: string;
  ctx: TrinoRequestContext;
  /** Owning principal — also the `X-Trino-User`. */
  // このクエリの所有者となる principal。Trino へのリクエストでは
  // `X-Trino-User` としても使われる。
  owner: string;
  datasourceId?: string;
  sessionReadOnly?: boolean;
  /** RBAC 解決後の role 名。SQL データソースの credential 選択に使う。 */
  roleName?: string;
  maxRows?: number;
  overflowMode?: OverflowMode;
  notebookId?: string;
  cellId?: string;
  /** false のとき RESULT_STORE への結果永続化を行わない (既定 true)。 */
  persistResult?: boolean;
}

/**
 * Bridges the query registry and history persistence: records a history row on
 * submit and updates it when the query settles.
 *
 * クエリレジストリと履歴永続化を橋渡しするサービス。クエリ提出時に履歴行を
 * 記録し、クエリが終端状態に達した時点でその行を更新する。
 */
export class QueryService {
  private readonly backgroundTasks = new Set<Promise<void>>();

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
    let capture: ResultJsonlCapture | undefined;
    const persistResult = params.persistResult !== false;
    const expiresAt = this.resultExpiresAt();
    const exec = this.params.registry.submit({
      statement: params.statement,
      ctx: params.ctx,
      datasourceId: params.datasourceId,
      sessionReadOnly: params.sessionReadOnly,
      roleName: params.roleName,
      maxRows: params.maxRows,
      overflowMode: params.overflowMode,
      queuePrincipal: params.owner,
      makeResultObserver: (queryId) => {
        if (!persistResult) return undefined;
        capture = this.createResultCapture(queryId);
        return capture ? this.createResultObserver(capture) : undefined;
      },
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
    const historyUpdated = Promise.all([inserted, exec.settled]).then(() => {
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
    this.trackBackground(historyUpdated);

    if (persistResult) {
      let resultObjectLinked = false;
      const resultPersisted = Promise.all([inserted, exec.settled])
        .then(async () => {
          // capture は実行枠の獲得時に生成するため、queue 中には undefined のままにする。
          const resultCapture = capture;
          if (!resultCapture) return;
          if (exec.state !== 'finished') {
            await resultCapture.abort();
            return;
          }
          await resultCapture.finish();
          await this.params.history.setResultObject(exec.queryId, resultCapture.key, expiresAt);
          resultObjectLinked = true;
          await this.params.audit?.record({
            actor: params.owner,
            action: 'query.result.persist',
            target: exec.queryId,
            datasource: exec.datasourceId,
            detail: {
              outcome: 'stored',
              objectKey: resultCapture.key,
              expiresAt,
            },
          });
        })
        .catch(async (err: unknown) => {
          const resultCapture = capture;
          if (resultCapture && !resultObjectLinked) {
            await cleanupUnlinkedResultObject(resultCapture.key, {
              store: this.params.resultStore!,
              deletions: this.params.resultObjectDeletions,
              now: this.params.now,
              logWarn: this.params.logWarn,
            });
          }
          if (this.params.logWarn) {
            this.params.logWarn('failed to persist query result', err);
          } else {
            console.warn('failed to persist query result', err);
          }
          await this.params.audit?.record({
            actor: params.owner,
            action: 'query.result.persist',
            target: exec.queryId,
            datasource: exec.datasourceId,
            detail: {
              outcome: 'failed',
              error: err instanceof Error ? err.message : String(err),
            },
          });
        });
      this.trackBackground(resultPersisted);
    }

    return exec;
  }

  /** 履歴更新、結果保存、監査記録の進行中 task がすべて終わるまで待つ。 */
  async drain(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  private trackBackground(task: Promise<unknown>): void {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.backgroundTasks.add(tracked);
    void tracked.then(() => this.backgroundTasks.delete(tracked));
  }

  private createResultCapture(queryId: string): ResultJsonlCapture | undefined {
    const store = this.params.resultStore;
    if (!store?.enabled) return undefined;
    const prefix = this.params.resultKeyPrefix ?? 'hubble-results/';
    return new ResultJsonlCapture(store, `${prefix}${queryId}.jsonl.gz`);
  }

  private createResultObserver(capture: ResultJsonlCapture): QueryResultObserver {
    return {
      onColumns: (columns) => capture.writeColumns(columns),
      onRows: (rows) => capture.writeRows(rows),
      onSettled: (exec) => {
        if (exec.state !== 'finished') void capture.abort();
      },
    };
  }

  private resultExpiresAt(): string {
    const now = this.params.now?.() ?? Date.now();
    const ttlDays = this.params.resultTtlDays ?? 7;
    return new Date(now + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  }
}

/**
 * このファイルは Query Guard 機能の中核サービス `EstimateService` を提供する。
 *
 * 役割: ユーザーが実行しようとしている SQL ステートメントに対して、解決済み
 * `QueryEngine` へ EXPLAIN (TYPE IO) の実行を委譲しスキャン量を見積もる。
 * 見積もり結果を TTL 付きキャッシュに保持し、同一クエリへの繰り返し EXPLAIN を
 * 避ける。EXPLAIN の実行本体は `engine/trinoEstimate.ts`（TrinoEngine 経由）に
 * 移し、このクラスはキャッシュ層とエンジン解決に専念する。
 *
 * アーキテクチャ上の位置づけ: HTTP ルート層（担当外）がクエリ実行前に
 * このサービスを呼び出し、`block` 判定であれば実行そのものを拒否する。
 * `mode=off` のときはこのサービス自体を呼ばず、ルート側で `guard.ts` の
 * `disabledEstimate()` を返す（このファイルは on/warn/enforce の経路のみを
 * 担当する）。
 */
import type { EstimateResult } from '@hubble/contracts';
import { AppError } from '../errors';
import type { QueryEngine } from '../engine/types';
import { resolveEngine } from '../engine/resolve';
import type { EffectiveGuardLimits } from '../rbac/guard';
import type { GuardLimits } from './guardVerdict';

/** Resolved guard settings the estimate service operates against. */
// EstimateService が動作する上で必要な、解決済みの Query Guard 設定一式。
// サーバー設定（ServerConfig）から必要な値だけを抜き出した形。
export interface EstimateGuardConfig {
  mode: GuardLimits['mode'];
  maxScanBytes: number;
  maxScanRows: number;
  onUnknown: GuardLimits['onUnknown'];
  estimateTimeoutMs: number;
  cacheTtlSeconds: number;
  bytesPerSecond: number;
}

// 見積もりリクエストのパラメータ。
export interface EstimateRequestParams {
  /** Statement exactly as it will be executed (already auto-LIMIT-rewritten by web). */
  // 実際に実行されるのと全く同じステートメント（web 側で auto-LIMIT 済み）。
  statement: string;
  catalog?: string;
  schema?: string;
  /**
   * Identity the EXPLAIN runs as — the same `X-Trino-User` as the user query
   * (the authenticated principal). Drives the cache key too.
   */
  // EXPLAIN を実行する際の identity。実際のユーザークエリと同じ
  // `X-Trino-User` を使う（認証済み principal）。キャッシュキーの一部にもなる。
  principal: string;
  /** Target datasource id. Omitted = default at request time. */
  // 実行先データソース id。省略時はリクエスト時点の既定データソース。
  datasourceId?: string;
  /** キャッシュ分離用のロール名。 */
  roleName?: string;
  /** ロール上書きを反映した実効 Guard 上限（省略時はサービス構築時のグローバル設定）。 */
  guard?: EffectiveGuardLimits;
}

// キャッシュ 1 エントリ分（見積もり結果 + 有効期限）。
interface CacheEntry {
  result: EstimateResult;
  expiresAt: number;
}

// キャッシュの最大保持件数。超過分は挿入順（古い順）に破棄する。
const MAX_CACHE_ENTRIES = 500;

/**
 * Query Guard estimation service (Query Guard feature).
 *
 * Resolves the target `QueryEngine`, delegates `EXPLAIN (TYPE IO, FORMAT JSON)`
 * to it, and caches the result per principal/catalog/schema/statement/datasource.
 * `mode=off` is handled by the caller (the route short-circuits before reaching
 * the service).
 *
 * Query Guard の見積もりサービス。対象エンジンを解決し、
 * `EXPLAIN (TYPE IO, FORMAT JSON)` を委譲して結果をキャッシュする。
 * `mode=off` は呼び出し元（ルート層）が処理し、このサービスまで到達しない。
 */
export class EstimateService {
  /** Insertion-ordered cache (Map preserves order; oldest evicted first). */
  // 挿入順を保持するキャッシュ（Map は挿入順を維持するため、最も古い
  // エントリから追い出す＝簡易 LRU 的な動作になる）。
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly engines: Map<string, QueryEngine>,
    private defaultDatasourceId: string,
    private readonly config: EstimateGuardConfig,
    private readonly now: () => number = Date.now,
  ) {}

  setDefaultDatasourceId(id: string): void {
    this.defaultDatasourceId = id;
  }

  invalidateDatasource(datasourceId: string): void {
    const prefix = `${datasourceId} `;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  // principal、catalog、schema、statement、datasourceId を連結してキャッシュキーを作る。
  // 同じユーザーでも catalog/schema やデータソースが異なれば別クエリとして扱う。
  private cacheKey(params: EstimateRequestParams, datasourceId: string): string {
    const guard = params.guard;
    const guardKey = guard
      ? [guard.mode, guard.maxScanBytes, guard.maxScanRows, guard.onUnknown].join(':')
      : 'global';
    return [
      datasourceId,
      params.roleName ?? 'global',
      guardKey,
      params.principal,
      params.catalog ?? '',
      params.schema ?? '',
      params.statement,
    ].join(' ');
  }

  private resolveLimits(params: EstimateRequestParams): GuardLimits {
    const g = params.guard;
    if (g) {
      return {
        mode: g.mode,
        maxScanBytes: g.maxScanBytes,
        maxScanRows: g.maxScanRows,
        onUnknown: g.onUnknown,
      };
    }
    return {
      mode: this.config.mode,
      maxScanBytes: this.config.maxScanBytes,
      maxScanRows: this.config.maxScanRows,
      onUnknown: this.config.onUnknown,
    };
  }

  /**
   * Return a cached estimate if it is still fresh, else `undefined`. Exposed so
   * the run path can reuse a recent estimate without a Trino round-trip.
   *
   * まだ有効期限内のキャッシュ済み見積もりがあればそれを返し、無ければ
   * `undefined` を返す。クエリ実行パス側が直近の見積もりを Trino への
   * 往復なしに再利用できるよう公開されている。
   */
  getCached(params: EstimateRequestParams): EstimateResult | undefined {
    const { datasourceId } = resolveEngine(
      this.engines,
      params.datasourceId,
      this.defaultDatasourceId,
    );
    const key = this.cacheKey(params, datasourceId);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      // 期限切れなら削除してキャッシュミス扱いにする。
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  // 見積もり結果をキャッシュへ格納する。TTL が 0 以下なら保存しない。
  private store(key: string, result: EstimateResult): void {
    if (this.config.cacheTtlSeconds <= 0) return;
    this.cache.set(key, {
      result,
      expiresAt: this.now() + this.config.cacheTtlSeconds * 1000,
    });
    // Evict oldest entries past the cap.
    // 上限件数を超えた分は挿入順で最も古いものから追い出す。
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Estimate, consulting the cache first. */
  // まずキャッシュを確認し、ヒットすればそれを返す。ミスであれば対象エンジンへ
  // 委譲して EXPLAIN を実行し、結果をキャッシュへ格納してから返す。
  async estimate(params: EstimateRequestParams): Promise<EstimateResult> {
    const { datasourceId, engine } = resolveEngine(
      this.engines,
      params.datasourceId,
      this.defaultDatasourceId,
    );

    if (!engine.capabilities.costEstimate) {
      throw AppError.badRequest(
        `Datasource ${datasourceId} does not support cost estimation`,
        'ESTIMATE_NOT_SUPPORTED',
      );
    }

    const key = this.cacheKey(params, datasourceId);
    const cached = this.getCached(params);
    if (cached) return cached;

    const limits = this.resolveLimits(params);
    const result = await engine.estimate(params, {
      mode: limits.mode,
      maxScanBytes: limits.maxScanBytes,
      maxScanRows: limits.maxScanRows,
      onUnknown: limits.onUnknown,
      estimateTimeoutMs: this.config.estimateTimeoutMs,
      bytesPerSecond: this.config.bytesPerSecond,
    });
    this.store(key, result);
    return result;
  }
}

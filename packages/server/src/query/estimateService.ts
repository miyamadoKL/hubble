/**
 * このファイルは Query Guard 機能の中核サービス `EstimateService` を提供する。
 *
 * 役割: ユーザーが実行しようとしている SQL ステートメントに対して、対象エンジンの
 * EXPLAIN (TYPE IO) を実行しスキャン量を見積もる。見積もり結果を TTL 付きキャッシュに
 * 保持し、同一クエリへの繰り返し EXPLAIN を避ける。
 */
import type { EstimateResult } from '@hubble/contracts';
import { AppError } from '../errors';
import type { QueryEngine } from '../engine/types';
import { resolveEngine } from '../engine/resolve';
import type { GuardLimits } from './guardVerdict';

/** Resolved guard settings the estimate service operates against. */
export interface EstimateGuardConfig {
  mode: GuardLimits['mode'];
  maxScanBytes: number;
  maxScanRows: number;
  onUnknown: GuardLimits['onUnknown'];
  estimateTimeoutMs: number;
  cacheTtlSeconds: number;
  bytesPerSecond: number;
}

export interface EstimateRequestParams {
  statement: string;
  catalog?: string;
  schema?: string;
  principal: string;
  datasourceId?: string;
}

interface CacheEntry {
  result: EstimateResult;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 500;

/**
 * Query Guard estimation service. Delegates EXPLAIN to the resolved QueryEngine
 * and caches results per principal/catalog/schema/statement/datasource.
 */
export class EstimateService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly engines: Map<string, QueryEngine>,
    private readonly defaultDatasourceId: string,
    private readonly config: EstimateGuardConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private cacheKey(params: EstimateRequestParams, datasourceId: string): string {
    return [
      datasourceId,
      params.principal,
      params.catalog ?? '',
      params.schema ?? '',
      params.statement,
    ].join(' ');
  }

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
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  private store(key: string, result: EstimateResult): void {
    if (this.config.cacheTtlSeconds <= 0) return;
    this.cache.set(key, {
      result,
      expiresAt: this.now() + this.config.cacheTtlSeconds * 1000,
    });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

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

    const result = await engine.estimate(params, {
      mode: this.config.mode,
      maxScanBytes: this.config.maxScanBytes,
      maxScanRows: this.config.maxScanRows,
      onUnknown: this.config.onUnknown,
      estimateTimeoutMs: this.config.estimateTimeoutMs,
      bytesPerSecond: this.config.bytesPerSecond,
    });
    this.store(key, result);
    return result;
  }
}
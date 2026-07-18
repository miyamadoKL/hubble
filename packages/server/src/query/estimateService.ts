/**
 * このファイルは Query Guard 機能の中核サービス `EstimateService` を提供する。
 *
 * 役割: ユーザーが実行しようとしている SQL ステートメントに対して、解決済み
 * `QueryEngine` へ EXPLAIN (TYPE IO) の実行を委譲しスキャン量を見積もる。
 * 見積もり結果を TTL 付きキャッシュに保持し、同一クエリへの繰り返し EXPLAIN を
 * 避ける。EXPLAIN の実行本体は `engine/trinoEstimate.ts`（TrinoEngine 経由）に
 * 移し、このクラスはキャッシュ層とエンジン解決に専念する。
 *
 * 呼び出し元ごとの挙動:
 * - `POST /api/queries/estimate`（見積もり専用エンドポイント。実行は行わない）
 *   は `mode=off` のときこのサービスを呼ばず `guard.ts` の
 *   `disabledEstimate()` を返す。`warn`/`enforce` では常にこのサービスを
 *   呼び出し、結果をそのままレスポンスとして返す。
 * - `POST /api/queries`（実際にクエリを実行するエンドポイント）は
 *   `mode === 'enforce'` かつ `engine.capabilities.costEstimate` のときだけ
 *   このサービスを呼び出し、`block` 判定なら実行を拒否する。`off`/`warn`
 *   では `disabledEstimate()` を返すことなく、見積もりなしでそのまま実行へ
 *   進む。
 * - `alert/evaluator.ts`、`schedule/scheduler.ts`、`workflow/runner.ts` も
 *   同様に `mode === 'enforce'` かつ costEstimate 対応エンジンのときだけ
 *   呼び出し、`block` 判定であれば実行を拒否する。
 */
import type { EstimateResult } from '@hubble/contracts';
import { AppError } from '../errors';
import type { QueryEngine } from '../engine/types';
import { resolveEngine } from '../engine/resolve';
import type { EffectiveGuardLimits } from '../rbac/guard';
import type { GuardLimits } from './guardVerdict';

/**
 * EstimateService が動作する上で必要な、解決済みの Query Guard 設定一式。
 * サーバー設定（ServerConfig）から必要な値だけを抜き出した形。
 */
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
  /** 実行予定のステートメント。 */
  statement: string;
  catalog?: string;
  schema?: string;
  /**
   * EXPLAIN を実行する際の identity。実際のユーザークエリと同じ
   * `X-Trino-User` を使う（認証済み principal）。キャッシュキーの一部にもなる。
   */
  principal: string;
  /** 実行先データソース id。省略時はリクエスト時点の既定データソース。 */
  datasourceId?: string;
  /** キャッシュ分離用のロール名。 */
  roleName?: string;
  /** ロール上書きを反映した実効 Guard 上限（省略時はサービス構築時のグローバル設定）。 */
  guard?: EffectiveGuardLimits;
}

// キャッシュ 1 エントリ分（見積もり結果 + 有効期限）。
interface CacheEntry {
  datasourceId: string;
  generation: number;
  result: EstimateResult;
  expiresAt: number;
}

// キャッシュの最大保持件数。超過分は挿入順（古い順）に破棄する。
const MAX_CACHE_ENTRIES = 500;
const DATASOURCE_RELOADING_CODE = 'DATASOURCE_RELOADING';
const MAX_ESTIMATE_ATTEMPTS = 2;

/**
 * Query Guard の見積もりサービス。対象エンジンを解決し、
 * `EXPLAIN (TYPE IO, FORMAT JSON)` を委譲して結果をキャッシュする。
 * `mode=off` はいずれの呼び出し元でもこのサービスへ到達しない
 * （`POST /api/queries/estimate` は `disabledEstimate()` で代替し、
 * `POST /api/queries` とスケジュール/ワークフロー/アラートの各実行経路は
 * `mode === 'enforce'` のときだけ呼び出す）。
 */
export class EstimateService {
  // 挿入順を保持するキャッシュ（Map は挿入順を維持するため、最も古い
  // エントリから追い出す＝簡易 LRU 的な動作になる）。
  //
  // `lru-cache` への置換は計測のうえ見送った。CacheEntry、Map、走査、
  // 有効期限判定、保存、eviction を合計しても実装 47 行しかなく、依存の
  // import と初期化を足す前から採用基準の 100 実装行削減に届かない。
  // さらに current clock、SWR、reload generation の所有者を減らせることが
  // 条件だが、cacheGenerations や engineGenerations による世代管理は
  // 引き続き自前で持つ必要があり、置換の実益がない。
  private readonly cache = new Map<string, CacheEntry>();
  // 同じ datasource ID のエンジンが差し替わった場合も旧見積もりを再利用しないよう、
  // エンジンオブジェクトごとに EstimateService 内の世代番号を割り当てる。
  private readonly engineGenerations = new WeakMap<QueryEngine, number>();
  private nextEngineGeneration = 1;
  private readonly cacheGenerations = new Map<string, number>();

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
    this.cacheGenerations.set(datasourceId, this.cacheGeneration(datasourceId) + 1);
    for (const [key, entry] of this.cache) {
      if (entry.datasourceId === datasourceId) this.cache.delete(key);
    }
  }

  /** データソースの現在のキャッシュ世代を返す。 */
  private cacheGeneration(datasourceId: string): number {
    return this.cacheGenerations.get(datasourceId) ?? 0;
  }

  private engineGeneration(engine: QueryEngine): number {
    const existing = this.engineGenerations.get(engine);
    if (existing !== undefined) return existing;
    const generation = this.nextEngineGeneration;
    this.nextEngineGeneration += 1;
    this.engineGenerations.set(engine, generation);
    return generation;
  }

  /** 見積もり開始時のデータソース世代とエンジンが現在も有効かを確認する。 */
  private isCurrentAttempt(
    params: EstimateRequestParams,
    datasourceId: string,
    engine: QueryEngine,
    generation: number,
  ): boolean {
    if (this.cacheGeneration(datasourceId) !== generation) return false;
    try {
      const current = resolveEngine(this.engines, params.datasourceId, this.defaultDatasourceId);
      return current.datasourceId === datasourceId && current.engine === engine;
    } catch {
      return false;
    }
  }

  // タプル境界を保持する JSON 配列でキャッシュキーを作り、各文字列に空白や
  // 区切り文字が含まれても別の実行コンテキストと衝突しないようにする。
  private cacheKey(
    params: EstimateRequestParams,
    datasourceId: string,
    engine: QueryEngine,
    cacheGeneration: number,
  ): string {
    const guard = params.guard;
    const guardKey = guard
      ? ['override', guard.mode, guard.maxScanBytes, guard.maxScanRows, guard.onUnknown]
      : ['global'];
    return JSON.stringify([
      1,
      datasourceId,
      cacheGeneration,
      this.engineGeneration(engine),
      params.roleName ?? null,
      guardKey,
      params.principal,
      params.catalog ?? null,
      params.schema ?? null,
      params.statement,
    ]);
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
   * まだ有効期限内のキャッシュ済み見積もりがあればそれを返し、無ければ
   * `undefined` を返す。クエリ実行パス側が直近の見積もりを Trino への
   * 往復なしに再利用できるよう公開されている。
   */
  getCached(params: EstimateRequestParams): EstimateResult | undefined {
    const { datasourceId, engine } = resolveEngine(
      this.engines,
      params.datasourceId,
      this.defaultDatasourceId,
    );
    const generation = this.cacheGeneration(datasourceId);
    const key = this.cacheKey(params, datasourceId, engine, generation);
    return this.getFresh(key, generation);
  }

  private getFresh(key: string, generation: number): EstimateResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.generation !== generation) {
      this.cache.delete(key);
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      // 期限切れなら削除してキャッシュミス扱いにする。
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  // 見積もり結果をキャッシュへ格納する。TTL が 0 以下なら保存しない。
  private store(
    key: string,
    datasourceId: string,
    generation: number,
    engine: QueryEngine,
    result: EstimateResult,
  ): void {
    if (this.config.cacheTtlSeconds <= 0) return;
    if (this.cacheGeneration(datasourceId) !== generation) return;
    if (this.engines.get(datasourceId) !== engine) return;
    this.cache.set(key, {
      datasourceId,
      generation,
      result,
      expiresAt: this.now() + this.config.cacheTtlSeconds * 1000,
    });
    // 上限件数を超えた分は挿入順で最も古いものから追い出す。
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  // まずキャッシュを確認し、ヒットすればそれを返す。ミスであれば対象エンジンへ
  // 委譲して EXPLAIN を実行し、結果をキャッシュへ格納してから返す。
  async estimate(params: EstimateRequestParams): Promise<EstimateResult> {
    for (let attempt = 0; attempt < MAX_ESTIMATE_ATTEMPTS; attempt += 1) {
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

      const generation = this.cacheGeneration(datasourceId);
      const key = this.cacheKey(params, datasourceId, engine, generation);
      const cached = this.getFresh(key, generation);
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
      if (!this.isCurrentAttempt(params, datasourceId, engine, generation)) continue;
      this.store(key, datasourceId, generation, engine, result);
      return result;
    }

    throw new AppError(503, {
      code: DATASOURCE_RELOADING_CODE,
      message: 'Datasource changed repeatedly while estimating the query; retry the request',
    });
  }
}

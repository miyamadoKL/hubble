/**
 * メタデータ（カタログ→スキーマ→テーブル→カラムのツリー）に対する
 * TTL + stale-while-revalidate キャッシュ層。`QueryEngine`（データソースごとの
 * メタデータ取得実装）をラップし、Trino への問い合わせ頻度を抑えつつ
 * 「今どのくらい新しいデータか」を呼び出し元（routes 層）へ伝える。
 * カタログ一覧、スキーマ一覧、テーブル一覧、カラム一覧を
 * それぞれ個別の `Map` でキャッシュし、キーは `datasourceId` とカタログ/スキーマ/
 * テーブル名の組み合わせ文字列。サンプル行（`getSample`）はキャッシュ対象外で常に
 * ライブ取得する。
 */
import type {
  Catalog,
  Column,
  MetadataResponse,
  SampleRowsResponse,
  SchemaItem,
  TableDetail,
  TableItem,
} from '@hubble/contracts';
import { AppError } from '../errors';
import type { QueryEngine } from '../engine/types';
import { resolveEngine } from '../engine/resolve';

/** 1件のキャッシュエントリ。キャッシュされた値そのものと、更新時刻、進行中の再検証を保持する。 */
interface CacheEntry<T> {
  items: T;
  updatedAt: number;
  generation: number;
  engine: QueryEngine;
  /** In-flight revalidation, deduped so we never double-fetch the same key. */
  // 実行中のバックグラウンド再取得。同じキーに対して二重に fetch しないよう
  // このプロミスで重複排除する。
  revalidating?: Promise<void>;
}

/** 階層ごとのキャッシュ上限。principal と role の増加による無制限な常駐を防ぐ。 */
const MAX_ENTRIES_PER_CACHE = 500;
const DATASOURCE_RELOADING_CODE = 'DATASOURCE_RELOADING';
const MAX_METADATA_FETCH_ATTEMPTS = 2;

interface MetadataFetchResult<T> {
  datasourceId: string;
  engine: QueryEngine;
  generation: number;
  items: T;
}

/**
 * TTL cache with stale-while-revalidate over QueryEngine metadata methods.
 *
 * - Fresh hit (within TTL): served from cache, `{source:'cache', stale:false}`.
 * - Stale hit: served immediately as `{source:'cache', stale:true}` and a
 *   background refresh is kicked off (deduped per key).
 * - Miss: fetched synchronously, `{source:'live', stale:false}`.
 * - `refresh()` forces a synchronous re-fetch and updates the cache.
 *
 * `QueryEngine` に対する TTL + stale-while-revalidate キャッシュ。
 * データソースと principal ごとに独立したキャッシュを保持する（キーに
 * `datasourceId` と principal を含める）。別キーへのアクセス時に期限切れエントリを
 * sweep し、階層ごとの件数上限も適用する。アクセス対象自身は stale 応答と再検証に
 * 利用するため sweep から除外する。
 *
 * - フレッシュヒット（TTL 内）: キャッシュから即座に返す
 *   `{source:'cache', stale:false}`。
 * - stale ヒット（TTL 超過）: 古い値をすぐに `{source:'cache', stale:true}` で
 *   返しつつ、バックグラウンドでキー単位に重複排除した再取得を開始する。
 * - ミス（未キャッシュ）: 同期的に fetch し、`{source:'live', stale:false}`
 *   で返す。
 * - `refresh()` は同期的に強制再取得してキャッシュを更新する（TTL 判定を
 *   経ない明示的なリフレッシュ）。
 */
export class MetadataService {
  private readonly catalogs = new Map<string, CacheEntry<Catalog[]>>();
  private readonly schemas = new Map<string, CacheEntry<SchemaItem[]>>();
  private readonly tables = new Map<string, CacheEntry<TableItem[]>>();
  private readonly columns = new Map<string, CacheEntry<Column[]>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly engines: Map<string, QueryEngine>,
    private defaultDatasourceId: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  setDefaultDatasourceId(id: string): void {
    this.defaultDatasourceId = id;
  }

  invalidateDatasource(datasourceId: string): void {
    this.generations.set(datasourceId, this.generation(datasourceId) + 1);
    const prefix = `${datasourceId}:`;
    for (const map of [this.catalogs, this.schemas, this.tables, this.columns]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
  }

  /** データソースの現在のキャッシュ世代を返す。 */
  private generation(datasourceId: string): number {
    return this.generations.get(datasourceId) ?? 0;
  }

  /** データソース id、principal、role、階層キーを連結したキャッシュキーを組み立てる。 */
  private cacheKey(
    datasourceId: string,
    principal: string,
    roleName: string | undefined,
    key: string,
  ): string {
    return `${datasourceId}:${principal}:${roleName ?? ''}:${key}`;
  }

  /** リクエストの datasourceId を解決し、対応するエンジンを返す。 */
  private resolveDatasource(datasourceId?: string): { datasourceId: string; engine: QueryEngine } {
    return resolveEngine(this.engines, datasourceId, this.defaultDatasourceId);
  }

  /** 取得開始時のデータソース世代とエンジンが現在も有効かを確認する。 */
  private isCurrentAttempt(
    requestedDatasourceId: string | undefined,
    datasourceId: string,
    engine: QueryEngine,
    generation: number,
  ): boolean {
    if (this.generation(datasourceId) !== generation) return false;
    try {
      const current = this.resolveDatasource(requestedDatasourceId);
      return current.datasourceId === datasourceId && current.engine === engine;
    } catch {
      return false;
    }
  }

  /** 現在世代で取得し、競合した場合だけ新しいエンジンで一度再試行する。 */
  private async fetchStable<T>(
    requestedDatasourceId: string | undefined,
    fetcher: (engine: QueryEngine) => Promise<T>,
  ): Promise<MetadataFetchResult<T>> {
    for (let attempt = 0; attempt < MAX_METADATA_FETCH_ATTEMPTS; attempt += 1) {
      const { datasourceId, engine } = this.resolveDatasource(requestedDatasourceId);
      const generation = this.generation(datasourceId);
      const items = await fetcher(engine);
      if (this.isCurrentAttempt(requestedDatasourceId, datasourceId, engine, generation)) {
        return { datasourceId, engine, generation, items };
      }
    }
    throw new AppError(503, {
      code: DATASOURCE_RELOADING_CODE,
      message: 'Datasource changed repeatedly while loading metadata; retry the request',
    });
  }

  // エントリが TTL を超えて古くなっているかどうかを判定する。
  private isStale(entry: CacheEntry<unknown>): boolean {
    return this.now() - entry.updatedAt > this.ttlMs;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** アクセス対象以外の期限切れエントリを削除する。 */
  private sweep<T>(map: Map<string, CacheEntry<T>>, preserveKey: string): void {
    for (const [key, entry] of map) {
      if (key === preserveKey) continue;
      if (this.isStale(entry)) map.delete(key);
    }
  }

  /** 世代付きエントリを保存し、古い挿入順から上限超過分を削除する。 */
  private store<T>(map: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
    map.delete(key);
    map.set(key, entry);
    while (map.size > MAX_ENTRIES_PER_CACHE) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * キャッシュ Map、データソース id、階層キー、フェッチ関数を受け取り、
   * TTL/stale-while-revalidate ロジックに従って結果を返す共通処理。
   * getCatalogs/getSchemas/getTables/getTableDetail の実体はすべてこの関数を
   * 薄くラップしたもの。
   */
  private async resolve<T>(
    map: Map<string, CacheEntry<T>>,
    requestedDatasourceId: string | undefined,
    principal: string,
    roleName: string | undefined,
    key: string,
    fetcher: (engine: QueryEngine) => Promise<T>,
  ): Promise<MetadataResponse<T extends Array<infer U> ? U : never>> {
    const { datasourceId, engine } = this.resolveDatasource(requestedDatasourceId);
    const cacheKey = this.cacheKey(datasourceId, principal, roleName, key);
    const generation = this.generation(datasourceId);
    this.sweep(map, cacheKey);
    let entry = map.get(cacheKey);
    if (entry && (entry.generation !== generation || entry.engine !== engine)) {
      map.delete(cacheKey);
      entry = undefined;
    }
    if (entry && entry.generation === generation && !this.isStale(entry)) {
      // フレッシュヒット: キャッシュ済みの値をそのまま返す。
      return this.envelope(entry.items, 'cache', false, entry.updatedAt);
    }
    if (entry && entry.generation === generation && this.isStale(entry)) {
      // Serve stale, revalidate in background (deduped).
      // stale ヒット: 古い値を即座に返しつつ、バックグラウンドで再取得する。
      // 既に revalidating が進行中なら新たな fetch は起動しない（重複排除）。
      if (!entry.revalidating) {
        entry.revalidating = fetcher(engine)
          .then((items) => {
            if (
              !this.isCurrentAttempt(requestedDatasourceId, datasourceId, engine, generation) ||
              map.get(cacheKey) !== entry
            ) {
              if (map.get(cacheKey) === entry) entry.revalidating = undefined;
              return;
            }
            this.store(map, cacheKey, {
              items,
              updatedAt: this.now(),
              generation,
              engine,
            });
          })
          .catch(() => {
            // Keep the stale entry on failure; clear the in-flight marker.
            // 再取得に失敗しても既存の stale なエントリはそのまま残し、
            // 次回呼び出しで再度リトライできるよう進行中マーカーだけ解除する。
            entry.revalidating = undefined;
          });
      }
      return this.envelope(entry.items, 'cache', true, entry.updatedAt);
    }
    // Miss: fetch synchronously.
    // ミス: キャッシュに存在しないため、同期的に fetch してから保存し返却する。
    const fetched = await this.fetchStable(requestedDatasourceId, fetcher);
    const updatedAt = this.now();
    const fetchedKey = this.cacheKey(fetched.datasourceId, principal, roleName, key);
    this.store(map, fetchedKey, {
      items: fetched.items,
      updatedAt,
      generation: fetched.generation,
      engine: fetched.engine,
    });
    return this.envelope(fetched.items, 'live', false, updatedAt);
  }

  // 取得した値、取得元（cache/live）、stale フラグ、更新時刻を
  // `MetadataResponse` の形にまとめる。
  private envelope<T>(
    items: T,
    sourceKind: 'cache' | 'live',
    stale: boolean,
    updatedAt: number,
  ): MetadataResponse<T extends Array<infer U> ? U : never> {
    return {
      items: items as unknown as (T extends Array<infer U> ? U : never)[],
      source: sourceKind,
      stale,
      lastUpdatedAt: this.iso(updatedAt),
    };
  }

  /** 指定した階層を現在世代で強制取得し、安定した結果だけを保存する。 */
  private async refreshSlice<T>(
    map: Map<string, CacheEntry<T>>,
    requestedDatasourceId: string | undefined,
    principal: string,
    roleName: string | undefined,
    key: string,
    fetcher: (engine: QueryEngine) => Promise<T>,
  ): Promise<void> {
    const fetched = await this.fetchStable(requestedDatasourceId, fetcher);
    this.store(map, this.cacheKey(fetched.datasourceId, principal, roleName, key), {
      items: fetched.items,
      updatedAt: this.now(),
      generation: fetched.generation,
      engine: fetched.engine,
    });
  }

  /** カタログ一覧を取得する（キャッシュキーは固定の `'_'`、カタログ単位に分かれないため）。 */
  getCatalogs(
    principal: string,
    datasourceId?: string,
    roleName?: string,
  ): Promise<MetadataResponse<Catalog>> {
    const opts = { principal, roleName };
    return this.resolve(this.catalogs, datasourceId, principal, roleName, '_', (engine) =>
      engine.listCatalogs(opts),
    );
  }

  /** 指定カタログのスキーマ一覧を取得する。キャッシュキーはカタログ名。 */
  getSchemas(
    catalog: string,
    principal: string,
    datasourceId?: string,
    roleName?: string,
  ): Promise<MetadataResponse<SchemaItem>> {
    const opts = { principal, roleName };
    return this.resolve(this.schemas, datasourceId, principal, roleName, catalog, (engine) =>
      engine.listSchemas(catalog, opts),
    );
  }

  /** 指定カタログ/スキーマのテーブル一覧を取得する。キャッシュキーは `"catalog schema"`。 */
  getTables(
    catalog: string,
    schema: string,
    principal: string,
    datasourceId?: string,
    roleName?: string,
  ): Promise<MetadataResponse<TableItem>> {
    const key = `${catalog} ${schema}`;
    const opts = { principal, roleName };
    return this.resolve(this.tables, datasourceId, principal, roleName, key, (engine) =>
      engine.listTables(catalog, schema, opts),
    );
  }

  /**
   * テーブル詳細（カラム一覧を含む）を取得する。カラム一覧のキャッシュキーは
   * `"catalog schema table"`。`TableDetail` へは、この関数側で catalog/schema/
   * name（table）を組み立てて付与する。
   */
  async getTableDetail(
    catalog: string,
    schema: string,
    table: string,
    principal: string,
    datasourceId?: string,
    roleName?: string,
  ): Promise<TableDetail> {
    const key = `${catalog} ${schema} ${table}`;
    const opts = { principal, roleName };
    const res = await this.resolve(
      this.columns,
      datasourceId,
      principal,
      roleName,
      key,
      async (engine) => {
        const detail = await engine.describeTable(catalog, schema, table, opts);
        return detail.columns;
      },
    );
    return { catalog, schema, name: table, columns: res.items };
  }

  /** Sample rows are not cached (always live — they are tiny and exploratory). */
  // サンプル行は探索的な用途で使われる小さいデータのため、キャッシュせず
  // 常に QueryEngine へライブ問い合わせする。
  getSample(
    catalog: string,
    schema: string,
    table: string,
    principal: string,
    limit = 10,
    datasourceId?: string,
    roleName?: string,
  ): Promise<SampleRowsResponse> {
    const { engine } = this.resolveDatasource(datasourceId);
    return engine.sampleTable(catalog, schema, table, limit, { principal, roleName });
  }

  /**
   * Force-refresh a slice of the cache. With no catalog: catalogs. With catalog
   * only: that catalog's schemas. With catalog+schema: that schema's tables.
   *
   * キャッシュの一部を強制的に再取得して更新する。引数の与え方で対象範囲が
   * 変わる: catalog 省略ならカタログ一覧、catalog のみならそのカタログの
   * スキーマ一覧、catalog+schema ならそのスキーマのテーブル一覧を更新する。
   * TTL 判定を経ずに即座に fetch する点が通常の get*() と異なる。
   */
  async refresh(
    principal: string,
    catalog?: string,
    schema?: string,
    datasourceId?: string,
    roleName?: string,
  ): Promise<void> {
    const opts = { principal, roleName };
    if (!catalog) {
      await this.refreshSlice(this.catalogs, datasourceId, principal, roleName, '_', (engine) =>
        engine.listCatalogs(opts),
      );
      return;
    }
    if (!schema) {
      await this.refreshSlice(this.schemas, datasourceId, principal, roleName, catalog, (engine) =>
        engine.listSchemas(catalog, opts),
      );
      return;
    }
    await this.refreshSlice(
      this.tables,
      datasourceId,
      principal,
      roleName,
      `${catalog} ${schema}`,
      (engine) => engine.listTables(catalog, schema, opts),
    );
  }
}

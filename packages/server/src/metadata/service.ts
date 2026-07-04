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
import type { QueryEngine } from '../engine/types';
import { resolveEngine } from '../engine/resolve';

/** 1件のキャッシュエントリ。キャッシュされた値そのものと、更新時刻、進行中の再検証を保持する。 */
interface CacheEntry<T> {
  items: T;
  updatedAt: number;
  /** In-flight revalidation, deduped so we never double-fetch the same key. */
  // 実行中のバックグラウンド再取得。同じキーに対して二重に fetch しないよう
  // このプロミスで重複排除する。
  revalidating?: Promise<void>;
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
 * `datasourceId` と principal を含める）。エントリの自動削除（TTL sweep）は
 * 行わず、stale 判定のみ。ユーザー数が増えるとメモリ使用量も増えるため、
 * データソース設定のリロード時に `invalidateDatasource` で一括破棄する。
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
    const prefix = `${datasourceId}:`;
    for (const map of [this.catalogs, this.schemas, this.tables, this.columns]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
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

  // エントリが TTL を超えて古くなっているかどうかを判定する。
  private isStale(entry: CacheEntry<unknown>): boolean {
    return this.now() - entry.updatedAt > this.ttlMs;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /**
   * キャッシュ Map、データソース id、階層キー、フェッチ関数を受け取り、
   * TTL/stale-while-revalidate ロジックに従って結果を返す共通処理。
   * getCatalogs/getSchemas/getTables/getTableDetail の実体はすべてこの関数を
   * 薄くラップしたもの。
   */
  private async resolve<T>(
    map: Map<string, CacheEntry<T>>,
    datasourceId: string,
    principal: string,
    roleName: string | undefined,
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<MetadataResponse<T extends Array<infer U> ? U : never>> {
    const cacheKey = this.cacheKey(datasourceId, principal, roleName, key);
    const entry = map.get(cacheKey);
    if (entry && !this.isStale(entry)) {
      // フレッシュヒット: キャッシュ済みの値をそのまま返す。
      return this.envelope(entry.items, 'cache', false, entry.updatedAt);
    }
    if (entry && this.isStale(entry)) {
      // Serve stale, revalidate in background (deduped).
      // stale ヒット: 古い値を即座に返しつつ、バックグラウンドで再取得する。
      // 既に revalidating が進行中なら新たな fetch は起動しない（重複排除）。
      if (!entry.revalidating) {
        entry.revalidating = fetcher()
          .then((items) => {
            map.set(cacheKey, { items, updatedAt: this.now() });
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
    const items = await fetcher();
    const updatedAt = this.now();
    map.set(cacheKey, { items, updatedAt });
    return this.envelope(items, 'live', false, updatedAt);
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

  /** カタログ一覧を取得する（キャッシュキーは固定の `'_'`、カタログ単位に分かれないため）。 */
  getCatalogs(
    principal: string,
    datasourceId?: string,
    roleName?: string,
  ): Promise<MetadataResponse<Catalog>> {
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    const opts = { principal, roleName };
    return this.resolve(this.catalogs, id, principal, roleName, '_', () =>
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
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    const opts = { principal, roleName };
    return this.resolve(this.schemas, id, principal, roleName, catalog, () =>
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
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    const key = `${catalog} ${schema}`;
    const opts = { principal, roleName };
    return this.resolve(this.tables, id, principal, roleName, key, () =>
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
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    const key = `${catalog} ${schema} ${table}`;
    const opts = { principal, roleName };
    const res = await this.resolve(this.columns, id, principal, roleName, key, async () => {
      const detail = await engine.describeTable(catalog, schema, table, opts);
      return detail.columns;
    });
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
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    const opts = { principal, roleName };
    if (!catalog) {
      const items = await engine.listCatalogs(opts);
      this.catalogs.set(this.cacheKey(id, principal, roleName, '_'), {
        items,
        updatedAt: this.now(),
      });
      return;
    }
    if (!schema) {
      const items = await engine.listSchemas(catalog, opts);
      this.schemas.set(this.cacheKey(id, principal, roleName, catalog), {
        items,
        updatedAt: this.now(),
      });
      return;
    }
    const items = await engine.listTables(catalog, schema, opts);
    this.tables.set(this.cacheKey(id, principal, roleName, `${catalog} ${schema}`), {
      items,
      updatedAt: this.now(),
    });
  }
}

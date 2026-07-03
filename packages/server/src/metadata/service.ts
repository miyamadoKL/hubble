/**
 * メタデータ（カタログ→スキーマ→テーブル→カラムのツリー）に対する
 * TTL + stale-while-revalidate キャッシュ層。QueryEngine をラップし、
 * データソースごとに独立したキャッシュを保持する（design.md §3）。
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

interface CacheEntry<T> {
  items: T;
  updatedAt: number;
  revalidating?: Promise<void>;
}

/**
 * TTL cache with stale-while-revalidate over QueryEngine metadata methods.
 */
export class MetadataService {
  private readonly catalogs = new Map<string, CacheEntry<Catalog[]>>();
  private readonly schemas = new Map<string, CacheEntry<SchemaItem[]>>();
  private readonly tables = new Map<string, CacheEntry<TableItem[]>>();
  private readonly columns = new Map<string, CacheEntry<Column[]>>();

  constructor(
    private readonly engines: Map<string, QueryEngine>,
    private readonly defaultDatasourceId: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private cacheKey(datasourceId: string, key: string): string {
    return `${datasourceId}:${key}`;
  }

  private resolveDatasource(datasourceId?: string): { datasourceId: string; engine: QueryEngine } {
    return resolveEngine(this.engines, datasourceId, this.defaultDatasourceId);
  }

  private isStale(entry: CacheEntry<unknown>): boolean {
    return this.now() - entry.updatedAt > this.ttlMs;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private async resolve<T>(
    map: Map<string, CacheEntry<T>>,
    datasourceId: string,
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<MetadataResponse<T extends Array<infer U> ? U : never>> {
    const cacheKey = this.cacheKey(datasourceId, key);
    const entry = map.get(cacheKey);
    if (entry && !this.isStale(entry)) {
      return this.envelope(entry.items, 'cache', false, entry.updatedAt);
    }
    if (entry && this.isStale(entry)) {
      if (!entry.revalidating) {
        entry.revalidating = fetcher()
          .then((items) => {
            map.set(cacheKey, { items, updatedAt: this.now() });
          })
          .catch(() => {
            entry.revalidating = undefined;
          });
      }
      return this.envelope(entry.items, 'cache', true, entry.updatedAt);
    }
    const items = await fetcher();
    const updatedAt = this.now();
    map.set(cacheKey, { items, updatedAt });
    return this.envelope(items, 'live', false, updatedAt);
  }

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

  getCatalogs(datasourceId?: string): Promise<MetadataResponse<Catalog>> {
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    return this.resolve(this.catalogs, id, '_', () => engine.listCatalogs());
  }

  getSchemas(catalog: string, datasourceId?: string): Promise<MetadataResponse<SchemaItem>> {
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    return this.resolve(this.schemas, id, catalog, () => engine.listSchemas(catalog));
  }

  getTables(
    catalog: string,
    schema: string,
    datasourceId?: string,
  ): Promise<MetadataResponse<TableItem>> {
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    const key = `${catalog} ${schema}`;
    return this.resolve(this.tables, id, key, () => engine.listTables(catalog, schema));
  }

  async getTableDetail(
    catalog: string,
    schema: string,
    table: string,
    datasourceId?: string,
  ): Promise<TableDetail> {
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    const key = `${catalog} ${schema} ${table}`;
    const res = await this.resolve(this.columns, id, key, async () => {
      const detail = await engine.describeTable(catalog, schema, table);
      return detail.columns;
    });
    return { catalog, schema, name: table, columns: res.items };
  }

  getSample(
    catalog: string,
    schema: string,
    table: string,
    limit = 10,
    datasourceId?: string,
  ): Promise<SampleRowsResponse> {
    const { engine } = this.resolveDatasource(datasourceId);
    return engine.sampleTable(catalog, schema, table, limit);
  }

  async refresh(catalog?: string, schema?: string, datasourceId?: string): Promise<void> {
    const { datasourceId: id, engine } = this.resolveDatasource(datasourceId);
    if (!catalog) {
      const items = await engine.listCatalogs();
      this.catalogs.set(this.cacheKey(id, '_'), { items, updatedAt: this.now() });
      return;
    }
    if (!schema) {
      const items = await engine.listSchemas(catalog);
      this.schemas.set(this.cacheKey(id, catalog), { items, updatedAt: this.now() });
      return;
    }
    const items = await engine.listTables(catalog, schema);
    this.tables.set(this.cacheKey(id, `${catalog} ${schema}`), { items, updatedAt: this.now() });
  }
}
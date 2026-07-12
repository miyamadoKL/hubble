// Part of the trino-lang module.
//
// SchemaCache is the synchronous read-side over the async MetadataSource. The
// completion / decoration passes (antlr4-c3) are synchronous, but metadata
// fetches are not. So this cache exposes *synchronous* getters that return
// whatever has been resolved so far, and *fire-and-forget* warmers that kick
// off async fetches. Monaco re-invokes completion on every keystroke, so newly
// resolved data simply appears on the next pass — no awaiting inside the
// synchronous candidate collection.
//
// 日本語: SchemaCache は非同期の MetadataSource に対する「同期的な読み取り側」を
// 提供する。補完や装飾のパス（antlr4-c3 を使う analyzer.ts）は同期的に動作する
// 必要があるが、メタデータ取得自体は非同期である。そこでこのキャッシュは、
// これまでに解決済みのデータをそのまま返す「同期 getter」と、非同期取得を
// 裏で開始するだけの「fire-and-forget（結果を待たない）ウォーマー」を分けて公開する。
// Monaco はキー入力のたびに補完処理を呼び直すので、新しく解決されたデータは
// 次のパスで自然に反映される。つまり同期的な候補収集の中で await する必要はない。

import Table from '../schema/Table';
import TableReference from '../schema/TableReference';
import { toForkTable, type MetadataSource } from './MetadataSource';

/**
 * MetadataSource（非同期）の結果を蓄積し、同期的に読み出せるようにするキャッシュ。
 * カタログ一覧、スキーマ一覧、テーブル一覧、テーブル詳細（カラム）をそれぞれ
 * 個別にキャッシュし、同一キーへの多重フェッチは in-flight ガードで防ぐ。
 */
export class SchemaCache {
  private readonly source: MetadataSource;
  private readonly getDatasourceId: () => string;

  // Resolved tables keyed by fully-qualified name.
  // 解決済みテーブルを完全修飾名（catalog.schema.table）をキーに保持する。
  private readonly tables = new Map<string, Table>();
  // Known table names (FQN) per "catalog.schema", populated by warmSchema.
  // "catalog schema" をキーに、既知のテーブル完全修飾名一覧を保持する（warmTables が埋める）。
  private readonly schemaTables = new Map<string, string[]>();
  private readonly catalogs = new Map<string, string[]>();
  private readonly schemas = new Map<string, string[]>(); // catalog -> schema names

  // In-flight de-dup guards so warmers don't stampede the source.
  // 同じキーへのウォーマーを重複させず、完了時にrequest所有者を照合するためのMap。
  private readonly inflight = new Map<string, symbol>();
  private readonly revisions = new Map<string, number>();

  constructor(source: MetadataSource, getDatasourceId: () => string = () => 'default') {
    this.source = source;
    this.getDatasourceId = getDatasourceId;
  }

  /** 指定したデータソース、または全データソースの解決済みメタデータを破棄する。 */
  invalidate(datasourceId?: string): void {
    const scopedKeys = [
      ...this.schemas.keys(),
      ...this.schemaTables.keys(),
      ...this.tables.keys(),
      ...this.inflight.keys(),
    ];
    const ids = datasourceId
      ? [datasourceId]
      : new Set([
          ...this.catalogs.keys(),
          ...this.revisions.keys(),
          ...scopedKeys.map((key) => key.split('\0', 1)[0]!),
          this.getDatasourceId(),
        ]);
    for (const id of ids) {
      this.catalogs.delete(id);
      this.deleteWithPrefix(this.schemas, `${id}\0`);
      this.deleteWithPrefix(this.schemaTables, `${id}\0`);
      this.deleteWithPrefix(this.tables, `${id}\0`);
      this.deleteWithPrefix(this.inflight, `${id}\0`);
      this.revisions.set(id, this.revision(id) + 1);
    }
  }

  // ---- synchronous reads (used by the antlr4-c3 / decoration pass) ----
  // ---- 同期読み取り系（antlr4-c3 による補完パスや装飾パスから呼ばれる） ----

  /**
   * All fully-qualified table names known so far (optionally filtered).
   *
   * これまでに判明している完全修飾テーブル名の一覧を返す（catalog/schema で
   * 絞り込み可能）。まだ warmTables が完了していない分は含まれない。
   */
  getTableNameList(catalogFilter?: string, schemaFilter?: string): string[] {
    const datasourceId = this.getDatasourceId();
    const names: string[] = [];
    for (const [key, tableNames] of this.schemaTables) {
      const [scope, cat, sch] = key.split('\0');
      if (scope !== datasourceId) continue;
      if ((catalogFilter && cat !== catalogFilter) || (schemaFilter && sch !== schemaFilter)) {
        continue;
      }
      names.push(...tableNames);
    }
    return names;
  }

  /** Catalog names known so far. */
  getCatalogList(): string[] {
    return this.catalogs.get(this.getDatasourceId()) ?? [];
  }

  /** Schema names for a catalog known so far. */
  getSchemaList(catalog: string): string[] {
    return this.schemas.get(`${this.getDatasourceId()}\0${catalog}`) ?? [];
  }

  /** A resolved table (with columns) if already cached, else undefined. */
  getTableIfCached(ref: TableReference): Table | undefined {
    return this.tables.get(`${this.getDatasourceId()}\0${ref.fullyQualified}`);
  }

  // ---- async warmers (fire-and-forget; safe to call every pass) ----

  /** Ensure the catalog list is being / has been fetched. */
  warmCatalogs(): void {
    const datasourceId = this.getDatasourceId();
    this.guard(datasourceId, 'catalogs', async (isCurrent) => {
      const catalogs = await this.source.listCatalogs();
      if (isCurrent()) this.catalogs.set(datasourceId, catalogs);
    });
  }

  /** Ensure a catalog's schema list is being / has been fetched. */
  warmSchemas(catalog: string): void {
    const datasourceId = this.getDatasourceId();
    this.guard(datasourceId, `schemas:${catalog}`, async (isCurrent) => {
      const schemas = await this.source.listSchemas(catalog);
      if (isCurrent()) this.schemas.set(`${datasourceId}\0${catalog}`, schemas);
    });
  }

  /** Ensure a schema's table list is being / has been fetched. */
  warmTables(catalog: string, schema: string): void {
    const datasourceId = this.getDatasourceId();
    this.guard(datasourceId, `tables:${catalog}.${schema}`, async (isCurrent) => {
      const tables = await this.source.listTables(catalog, schema);
      if (isCurrent()) {
        this.schemaTables.set(
          `${datasourceId}\0${catalog}\0${schema}`,
          tables.map((t) => `${catalog}.${schema}.${t}`),
        );
      }
    });
  }

  /** Ensure a table's columns are being / have been fetched. */
  warmTable(ref: TableReference): void {
    const datasourceId = this.getDatasourceId();
    const tableKey = `${datasourceId}\0${ref.fullyQualified}`;
    if (this.tables.has(tableKey)) return;
    this.guard(datasourceId, `table:${ref.fullyQualified}`, async (isCurrent) => {
      const detail = await this.source.getTable(ref.catalogName, ref.schemaName, ref.tableName);
      if (detail && isCurrent()) {
        this.tables.set(tableKey, toForkTable(detail));
      }
    });
  }

  /**
   * Resolve a table, awaiting if needed. Used by the hover provider, which can
   * afford to be async (Monaco hover supports thenable results).
   */
  async resolveTable(ref: TableReference): Promise<Table | undefined> {
    const datasourceId = this.getDatasourceId();
    const tableKey = `${datasourceId}\0${ref.fullyQualified}`;
    const revision = this.revision(datasourceId);
    const cached = this.tables.get(tableKey);
    if (cached) return cached;
    const detail = await this.source.getTable(ref.catalogName, ref.schemaName, ref.tableName);
    if (!detail) return undefined;
    const table = toForkTable(detail);
    if (revision === this.revision(datasourceId)) this.tables.set(tableKey, table);
    return table;
  }

  private guard(
    datasourceId: string,
    key: string,
    run: (isCurrent: () => boolean) => Promise<void>,
  ): void {
    key = `${datasourceId}\0${key}`;
    if (this.inflight.has(key)) return;
    const revision = this.revision(datasourceId);
    const requestToken = Symbol(key);
    this.inflight.set(key, requestToken);
    run(() => revision === this.revision(datasourceId))
      .catch(() => {
        // Swallow: metadata is best-effort for completion/highlight. Errors
        // surface elsewhere (the schema tree / API client).
      })
      .finally(() => {
        // invalidate後に同じkeyを取得した新requestの所有権は、旧requestから削除させない。
        if (this.inflight.get(key) === requestToken) this.inflight.delete(key);
      });
  }

  private revision(datasourceId: string): number {
    return this.revisions.get(datasourceId) ?? 0;
  }

  private deleteWithPrefix<T>(values: Map<string, T> | Set<string>, prefix: string): void {
    for (const key of values.keys()) {
      if (key.startsWith(prefix)) values.delete(key);
    }
  }
}

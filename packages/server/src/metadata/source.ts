import type { Catalog, Column, SampleRowsResponse, SchemaItem, TableItem } from '@hubble/contracts';
import type { TrinoClient } from '../trino/client';
import { runToCompletion } from '../trino/runner';
import type { TrinoColumn, TrinoRequestContext } from '../trino/types';

/**
 * Trino に対してメタデータ (カタログ/スキーマ/テーブル/カラム/サンプル行) を
 * 問い合わせる、キャッシュを持たない「生」のデータソース実装。
 *
 * `system.metadata.catalogs` と各カタログの `information_schema` を SQL で
 * 問い合わせるだけの薄いレイヤーで、結果の保持や TTL 管理などは一切行わない。
 * キャッシュ層は metadata/service.ts の `MetadataService` が
 * 別途この上に被せる。ここで組み立てる SQL には利用者からの入力
 * (catalog/schema/table 名) が識別子やリテラルとして埋め込まれるため、
 * SQL インジェクション対策として quoteIdent/quoteString によるエスケープを必ず経由する。
 */

/** Double-quote-escape a Trino identifier. */
// 日本語: Trino の識別子 (テーブル名等) をダブルクォートで囲み、識別子内の
// ダブルクォート自体は "" にエスケープして SQL インジェクションを防ぐ。
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Single-quote-escape a Trino string literal. */
// 日本語: Trino の文字列リテラル (WHERE 句の値等) をシングルクォートで囲み、
// リテラル内のシングルクォートは '' にエスケープする。
function quoteString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

// 日本語: null/undefined を空文字列に、それ以外は String() で文字列化する
// ヘルパー。Trino の情報スキーマの結果セルには null が含まれ得るため利用する。
function toStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Trino-backed metadata source. Reads `system.metadata.catalogs` and
 * `information_schema`. All queries use the metadata source tag.
 *
 * 日本語: 各 fetchXxx メソッドは runToCompletion (trino/runner.ts) を使い、
 * 対象の SQL を完走させて全行を受け取ってから加工する (メタデータのレスポンスは
 * 通常小さいため、ストリーミングではなく一括取得で十分)。ctx() で
 * X-Trino-Source をこのインスタンスの source 文字列に固定し、メタデータ由来の
 * クエリであることを Trino 側のログ/監査から識別できるようにする。
 */
export class MetadataSource {
  constructor(
    private readonly client: TrinoClient,
    // 日本語: このソースが発行する全クエリに付与する X-Trino-Source タグ。
    private readonly source: string,
  ) {}

  // 日本語: TrinoRequestContext のデフォルト (source のみ設定) を作り、
  // 必要に応じて追加フィールド (catalog/schema 等) を上書きできるヘルパー。
  private ctx(extra?: Partial<TrinoRequestContext>): TrinoRequestContext {
    return { source: this.source, ...extra };
  }

  /** カタログ一覧を取得する (`system.metadata.catalogs` を名前順で全件取得)。 */
  async fetchCatalogs(principal: string): Promise<Catalog[]> {
    const { rows } = await runToCompletion(
      this.client,
      'SELECT catalog_name FROM system.metadata.catalogs ORDER BY catalog_name',
      this.ctx({ user: principal }),
    );
    return rows.map((r) => ({ name: toStr(r[0]) }));
  }

  /** 指定カタログのスキーマ一覧を取得する (`<catalog>.information_schema.schemata`)。 */
  async fetchSchemas(catalog: string, principal: string): Promise<SchemaItem[]> {
    const { rows } = await runToCompletion(
      this.client,
      `SELECT schema_name FROM ${quoteIdent(catalog)}.information_schema.schemata ORDER BY schema_name`,
      this.ctx({ user: principal }),
    );
    return rows.map((r) => ({ name: toStr(r[0]) }));
  }

  /**
   * 指定カタログ/スキーマのテーブル一覧を取得する
   * (`<catalog>.information_schema.tables` を table_schema でフィルタ)。
   * table_type (BASE TABLE/VIEW 等) は空文字なら省略する。
   */
  async fetchTables(catalog: string, schema: string, principal: string): Promise<TableItem[]> {
    const { rows } = await runToCompletion(
      this.client,
      `SELECT table_name, table_type FROM ${quoteIdent(catalog)}.information_schema.tables ` +
        `WHERE table_schema = ${quoteString(schema)} ORDER BY table_name`,
      this.ctx({ user: principal }),
    );
    return rows.map((r) => {
      const item: TableItem = { name: toStr(r[0]) };
      const type = toStr(r[1]);
      if (type) item.type = type;
      return item;
    });
  }

  /**
   * 指定テーブルのカラム一覧を取得する
   * (`<catalog>.information_schema.columns` を table_schema/table_name で
   * フィルタし、ordinal_position 順 = テーブル定義上の並び順で返す)。
   * comment は null/空文字なら省略する。
   */
  async fetchColumns(
    catalog: string,
    schema: string,
    table: string,
    principal: string,
  ): Promise<Column[]> {
    const { rows } = await runToCompletion(
      this.client,
      `SELECT column_name, data_type, comment FROM ${quoteIdent(catalog)}.information_schema.columns ` +
        `WHERE table_schema = ${quoteString(schema)} AND table_name = ${quoteString(table)} ` +
        `ORDER BY ordinal_position`,
      this.ctx({ user: principal }),
    );
    return rows.map((r) => {
      const col: Column = { name: toStr(r[0]), type: toStr(r[1]) };
      const comment = r[2];
      if (comment !== null && comment !== undefined && toStr(comment) !== '') {
        col.comment = toStr(comment);
      }
      return col;
    });
  }

  /**
   * Sample up to `limit` rows from a table (default 10).
   *
   * 日本語: `SELECT * ... LIMIT n` を直接実行し、常にライブ取得の結果
   * (`source: 'live'`) として返す。MetadataService 側でもキャッシュされない
   * (探索的な用途で使われる小さいデータのため)。
   */
  async fetchSample(
    catalog: string,
    schema: string,
    table: string,
    limit: number,
    principal: string,
  ): Promise<SampleRowsResponse> {
    const statement = `SELECT * FROM ${quoteIdent(catalog)}.${quoteIdent(schema)}.${quoteIdent(
      table,
    )} LIMIT ${limit}`;
    const { columns, rows } = await runToCompletion(
      this.client,
      statement,
      this.ctx({ user: principal }),
    );
    return {
      columns: toColumns(columns),
      rows,
      source: 'live',
    };
  }
}

// 日本語: Trino のカラム表現 (TrinoColumn) を契約 (@hubble/contracts) の
// Column 型へ変換する。type 以外の付随情報 (comment 等) はここでは持たない。
function toColumns(columns: TrinoColumn[]): Column[] {
  return columns.map((c) => ({ name: c.name, type: c.type }));
}

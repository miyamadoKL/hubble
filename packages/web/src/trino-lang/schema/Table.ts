// schema/ 配下のメタデータモデル（カタログ → スキーマ → テーブル → カラム）のうち、
// 「テーブル（またはビュー）」を表すクラス。カラム一覧の読み込み状態（ローディング中/
// エラー）も保持し、SchemaCache や補完候補生成（analyzer.ts）から参照される。

import Column from './Column';

/**
 * A table (or view) and its resolved column list.
 *
 * テーブル（またはビュー）と、そこから解決済みのカラム一覧を表す値オブジェクト。
 * カラムは非同期に取得されるため、ローディング状態とエラー状態も保持する。
 */
class Table {
  private name: string;
  private columns: Column[] = [];
  private error: string = '';
  private isLoadingColumns: boolean = false;

  constructor(name: string) {
    this.name = name;
  }

  getName() {
    return this.name;
  }

  getColumns() {
    return this.columns;
  }

  getError() {
    return this.error;
  }

  isLoading() {
    return this.isLoadingColumns;
  }

  setLoading(loading: boolean) {
    this.isLoadingColumns = loading;
  }

  // カラムが 1 件でも読み込まれているか、エラーが記録されていれば「読み込み済み」とみなす。
  hasLoadedColumns() {
    return this.columns.length > 0 || this.error !== '';
  }

  // SELECT 句にそのまま展開できる「カラム名, カラム名, ...」形式の文字列を返す。
  getColumnsForSelect() {
    return this.columns.map((column) => column.getName()).join(', ');
  }

  /**
   * Plain-text column listing (name + type per line) for hover tooltips.
   *
   * ホバーツールチップ用に、1 行につき「カラム名 型」を並べたプレーンテキストを返す。
   */
  getFullSchemaAsString() {
    return this.columns.map((column) => `${column.getName()} ${column.getType()}`).join('\n');
  }

  // エラーを記録し、同時にローディング中フラグを解除する（エラーで読み込みが終わるため）。
  setError(error: string) {
    this.error = error;
    this.isLoadingColumns = false;
  }
}

export default Table;

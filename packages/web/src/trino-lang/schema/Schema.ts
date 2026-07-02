// schema/ 配下のメタデータモデルにおける中間階層「スキーマ」を表すクラス。
// Catalog に保持され、配下に複数の Table を名前で保持する。

import Table from './Table';

/**
 * A schema and the tables/views it contains.
 *
 * スキーマと、その中に含まれるテーブル/ビュー群を表す値オブジェクト。
 */
class Schema {
  private name: string;
  private tables: Map<string, Table> = new Map<string, Table>();

  constructor(name: string) {
    this.name = name;
  }

  getName() {
    return this.name;
  }

  getTables() {
    return this.tables;
  }

  // テーブル名をキーに登録する。同名テーブルが既にあれば上書きする。
  addTable(table: Table) {
    this.tables.set(table.getName(), table);
  }
}

export default Schema;

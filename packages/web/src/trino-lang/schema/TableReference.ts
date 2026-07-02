// schema/ 配下のメタデータモデルの一部だが、Catalog/Schema/Table/Column の階層構造
// そのものではなく、SQL 文中に現れた「テーブル名への参照」を表す軽量な値オブジェクト。
// analyzer.ts や SqlBaseListenerImpl.ts がパース結果からこれを組み立て、
// SchemaCache が実体（Table）の解決キーとして使う。

// TableReference is a pure name holder; it carries no back-references into a
// SchemaProvider. Resolution against live metadata is the caller's job
// (via the DI'd MetadataSource).
//
// TableReference は名前だけを保持する純粋な値オブジェクトで、SchemaProvider への
// 逆参照は持たない。実際のメタデータへの解決は呼び出し側（DI された MetadataSource
// 経由）の責務とする。

/**
 * A (possibly partially qualified) reference to a table by name.
 *
 * テーブルへの（完全修飾とは限らない）名前参照。catalog.schema.table の 3 要素と、
 * それらを結合した完全修飾名 (fullyQualified) を保持する。
 */
class TableReference {
  catalogName: string;
  schemaName: string;
  tableName: string;
  fullyQualified: string;

  constructor(catalogName: string, schemaName: string, tableName: string) {
    this.catalogName = catalogName;
    this.schemaName = schemaName;
    this.tableName = tableName;
    this.fullyQualified = this.getFullyQualified();
  }

  // "." で分割して 3 要素あるかどうかで完全修飾名（catalog.schema.table）かを判定する。
  static isFullyQualified(proposedName: string) {
    return proposedName.split('.').length === 3;
  }

  // 完全修飾名の文字列を "." で分割し、3 パーツから TableReference を組み立てる。
  // 欠けているパートは空文字で補う（呼び出し側は事前に isFullyQualified で検証する想定）。
  static fromFullyQualified(fullyQualifiedTableName: string) {
    const parts = fullyQualifiedTableName.split('.');
    return new TableReference(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '');
  }

  private getFullyQualified(): string {
    return this.catalogName + '.' + this.schemaName + '.' + this.tableName;
  }
}

export default TableReference;

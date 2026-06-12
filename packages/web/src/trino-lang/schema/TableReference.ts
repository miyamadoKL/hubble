// Forked from trino-query-ui (Apache-2.0). See repo-root NOTICE.
// Adapted for hue_fable: the original held back-references into the singleton
// SchemaProvider (getCatalog/getSchema/getTable). Those are removed — a
// TableReference is now a pure name holder. Resolution against live metadata is
// the caller's job (via the DI'd MetadataSource).

/** A (possibly partially qualified) reference to a table by name. */
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

  static isFullyQualified(proposedName: string) {
    return proposedName.split('.').length === 3;
  }

  static fromFullyQualified(fullyQualifiedTableName: string) {
    const parts = fullyQualifiedTableName.split('.');
    return new TableReference(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '');
  }

  private getFullyQualified(): string {
    return this.catalogName + '.' + this.schemaName + '.' + this.tableName;
  }
}

export default TableReference;

/**
 * SQL 識別子の安全な引用。
 */

/** MySQL 識別子をバッククォートで引用する。 */
export function quoteMysqlIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** PostgreSQL 識別子を二重引用符で引用する。 */
export function quotePgIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** MySQL の schema.table を引用する。 */
export function mysqlTableRef(schema: string, table: string): string {
  return `${quoteMysqlIdentifier(schema)}.${quoteMysqlIdentifier(table)}`;
}

/** PostgreSQL の schema.table を引用する。 */
export function pgTableRef(schema: string, table: string): string {
  return `${quotePgIdentifier(schema)}.${quotePgIdentifier(table)}`;
}

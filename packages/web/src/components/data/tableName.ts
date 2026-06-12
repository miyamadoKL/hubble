// Pure helpers for turning a tree node into the text inserted at the caret
// (design.md §5: table は context を考慮した相対名/FQN、column は名前) and for
// building a SELECT template (design.md §5: ダブルクリックで SELECT 雛形).
//
// Trino identifiers are quoted with double quotes only when they aren't a plain
// lowercase identifier — this keeps the common tpch case clean (`orders`) while
// staying correct for mixed-case / reserved-word names (`"My Table"`).

const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Quote a Trino identifier only when it isn't a plain lowercase identifier. */
export function quoteIdentifier(name: string): string {
  if (PLAIN_IDENTIFIER.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export interface TableRef {
  catalog: string;
  schema: string;
  name: string;
}

export interface EditorContext {
  catalog?: string;
  schema?: string;
}

/**
 * The name to insert for a table, relative to the active context:
 *   - same catalog + schema → bare `table`
 *   - same catalog, other schema → `schema.table`
 *   - different catalog → fully-qualified `catalog.schema.table`
 *
 * Each part is quoted only when necessary.
 */
export function relativeTableName(ref: TableRef, ctx: EditorContext): string {
  const t = quoteIdentifier(ref.name);
  if (ctx.catalog === ref.catalog && ctx.schema === ref.schema) return t;
  const s = quoteIdentifier(ref.schema);
  if (ctx.catalog === ref.catalog) return `${s}.${t}`;
  const c = quoteIdentifier(ref.catalog);
  return `${c}.${s}.${t}`;
}

/**
 * A SELECT template for a table (design.md §5): explicit column list when known,
 * else `*`, qualified by the same relative-name rules, with a LIMIT.
 */
export function selectTemplate(
  ref: TableRef,
  columns: string[],
  ctx: EditorContext,
  limit = 100,
): string {
  const cols = columns.length > 0 ? columns.map(quoteIdentifier).join(', ') : '*';
  const from = relativeTableName(ref, ctx);
  return `SELECT ${cols}\nFROM ${from}\nLIMIT ${limit}`;
}

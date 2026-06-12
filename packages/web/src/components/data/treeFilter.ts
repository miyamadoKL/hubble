// Pure tree-filtering logic for the Data browser (design.md §5: 検索フィルタ,
// マッチパスは自動展開). Lifted out of the React component so the lazy-load
// expansion behaviour is unit-testable without rendering Monaco / TanStack.
//
// The browser lazy-loads children on expand, so a filter can only "see into"
// branches whose children are already cached. `expandedForFilter` augments the
// user's manual expansion set with any already-loaded catalog/schema that
// contains a matching table — so the match surfaces — while leaving unloaded
// branches untouched (the filter genuinely can't reach them, and that's fine).

export interface LoadedTree {
  /** schema names by catalog, for catalogs whose schema list is cached. */
  schemasByCatalog: Map<string, string[]>;
  /** table names by `${catalog}::${schema}`, for cached table lists. */
  tablesBySchema: Map<string, string[]>;
}

export function schemaKey(catalog: string, schema: string): string {
  return `${catalog}::${schema}`;
}

/** Case-insensitive substring match (empty needle matches everything). */
export function matchesNeedle(value: string, needle: string): boolean {
  return !needle || value.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Given the user's explicit `expanded` set, a `needle`, and the currently-loaded
 * tree, return the set of node keys that should render as expanded. With no
 * needle the explicit set is returned unchanged. With a needle, any loaded
 * catalog/schema that (transitively) contains a matching table is added so the
 * match is visible.
 *
 * Node keys: a catalog is keyed by its name; a schema by `catalog::schema`.
 */
export function expandedForFilter(
  expanded: ReadonlySet<string>,
  needle: string,
  loaded: LoadedTree,
): Set<string> {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return new Set(expanded);

  const next = new Set(expanded);
  for (const [catalog, schemas] of loaded.schemasByCatalog) {
    let catalogHasMatch = false;
    for (const schema of schemas) {
      const tables = loaded.tablesBySchema.get(schemaKey(catalog, schema));
      if (!tables) continue;
      if (tables.some((t) => matchesNeedle(t, trimmed))) {
        next.add(schemaKey(catalog, schema));
        catalogHasMatch = true;
      }
    }
    if (catalogHasMatch) next.add(catalog);
  }
  return next;
}

/**
 * Filter a node's children by the needle. With no needle, the list is returned
 * as-is; otherwise only matching names survive. Shared by table and column
 * lists so filtering stays consistent.
 */
export function filterByNeedle<T>(items: T[], name: (item: T) => string, needle: string): T[] {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter((i) => matchesNeedle(name(i), trimmed));
}

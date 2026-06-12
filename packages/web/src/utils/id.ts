// Stable client-side ids for cells and draft notebooks (design.md §4: cellId is
// a stable key). `crypto.randomUUID` is available in every target browser and in
// jsdom (Node ≥ 19), so no extra dependency is needed.

/** A stable unique id, optionally namespaced with a short prefix. */
export function uid(prefix = ''): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}

/**
 * API path constants and type-safe path builders (design.md §7).
 * The single source of truth for endpoint paths shared by server and web.
 */

const enc = encodeURIComponent;

export const apiRoutes = {
  healthz: () => '/api/healthz',
  config: () => '/api/config',
  me: () => '/api/me',

  // Metadata
  catalogs: () => '/api/catalogs',
  schemas: (catalog: string) => `/api/catalogs/${enc(catalog)}/schemas`,
  tables: (catalog: string, schema: string) =>
    `/api/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables`,
  table: (catalog: string, schema: string, table: string) =>
    `/api/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables/${enc(table)}`,
  tableSample: (catalog: string, schema: string, table: string) =>
    `/api/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables/${enc(table)}/sample`,
  metadataRefresh: () => '/api/metadata/refresh',

  // Queries
  queries: () => '/api/queries',
  query: (id: string) => `/api/queries/${enc(id)}`,
  queryEvents: (id: string) => `/api/queries/${enc(id)}/events`,
  queryRows: (id: string) => `/api/queries/${enc(id)}/rows`,
  queryDownloadCsv: (id: string) => `/api/queries/${enc(id)}/download.csv`,

  // Notebooks
  notebooks: () => '/api/notebooks',
  notebook: (id: string) => `/api/notebooks/${enc(id)}`,

  // Saved queries
  savedQueries: () => '/api/saved-queries',
  savedQuery: (id: string) => `/api/saved-queries/${enc(id)}`,

  // History
  history: () => '/api/history',
} as const;

export type ApiRoutes = typeof apiRoutes;

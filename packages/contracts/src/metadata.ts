import { z } from 'zod';
import { isoTimestamp } from './common';

/**
 * Metadata model (design.md §4, §7).
 * `system.metadata.catalogs` / `information_schema.tables` / `information_schema.columns`
 * wrapped by the server with a TTL cache + stale-while-revalidate.
 */

export const catalogSchema = z.object({
  name: z.string(),
});

export const schemaItemSchema = z.object({
  name: z.string(),
});

export const tableItemSchema = z.object({
  name: z.string(),
  /** 'BASE TABLE' | 'VIEW' | ... as reported by information_schema.tables. */
  type: z.string().optional(),
});

export const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  comment: z.string().optional(),
});

export const tableDetailSchema = z.object({
  catalog: z.string(),
  schema: z.string(),
  name: z.string(),
  comment: z.string().optional(),
  columns: z.array(columnSchema),
});

export type Catalog = z.infer<typeof catalogSchema>;
export type SchemaItem = z.infer<typeof schemaItemSchema>;
export type TableItem = z.infer<typeof tableItemSchema>;
export type Column = z.infer<typeof columnSchema>;
export type TableDetail = z.infer<typeof tableDetailSchema>;

/** Source of a metadata payload. */
export const metadataSourceSchema = z.enum(['cache', 'live']);
export type MetadataSource = z.infer<typeof metadataSourceSchema>;

/**
 * Generic metadata response envelope (design.md §7):
 * `MetadataResponse<T> = { items, source, stale, lastUpdatedAt }`.
 *
 * Use as a schema factory: `metadataResponseSchema(catalogSchema)`.
 */
export function metadataResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    source: metadataSourceSchema,
    stale: z.boolean(),
    /** ISO 8601 timestamp of when the underlying data was last refreshed. */
    lastUpdatedAt: isoTimestamp,
  });
}

export type MetadataResponse<T> = {
  items: T[];
  source: MetadataSource;
  stale: boolean;
  lastUpdatedAt: string;
};

// Concrete response schemas for each metadata endpoint.
export const catalogsResponseSchema = metadataResponseSchema(catalogSchema);
export const schemasResponseSchema = metadataResponseSchema(schemaItemSchema);
export const tablesResponseSchema = metadataResponseSchema(tableItemSchema);

export type CatalogsResponse = z.infer<typeof catalogsResponseSchema>;
export type SchemasResponse = z.infer<typeof schemasResponseSchema>;
export type TablesResponse = z.infer<typeof tablesResponseSchema>;

/** Sample-rows response for `GET .../tables/:t/sample` (design.md §7: 10 行サンプル). */
export const sampleRowsResponseSchema = z.object({
  columns: z.array(columnSchema),
  rows: z.array(z.array(z.unknown())),
  source: metadataSourceSchema,
});

export type SampleRowsResponse = z.infer<typeof sampleRowsResponseSchema>;

/** Request body for `POST /api/metadata/refresh`. */
export const metadataRefreshRequestSchema = z.object({
  catalog: z.string().optional(),
  schema: z.string().optional(),
});

export type MetadataRefreshRequest = z.infer<typeof metadataRefreshRequestSchema>;

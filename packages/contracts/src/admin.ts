import { z } from 'zod';
import { queryStateSchema, queryStatsSchema } from './query';

/**
 * 管理 API: 全ユーザーのクエリ実行一覧（Operations ビュー用）。
 */
export const adminQueryItemSchema = z.object({
  queryId: z.string(),
  owner: z.string(),
  datasourceId: z.string(),
  /** 先頭 200 文字に切り詰めた SQL 文。 */
  statement: z.string(),
  state: queryStateSchema,
  /** 投入からの経過時間（ミリ秒）。 */
  elapsedMs: z.number().int().nonnegative(),
  stats: queryStatsSchema.optional(),
});
export type AdminQueryItem = z.infer<typeof adminQueryItemSchema>;

export const adminQueriesResponseSchema = z.object({
  items: z.array(adminQueryItemSchema),
});
export type AdminQueriesResponse = z.infer<typeof adminQueriesResponseSchema>;

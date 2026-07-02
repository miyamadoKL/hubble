import { z } from 'zod';
import { isoTimestamp } from './common';

/**
 * SavedQuery model (design.md §4).
 * `SavedQuery { id, name, description, statement, catalog?, schema?, isFavorite, createdAt, updatedAt }`
 *
 * ユーザーが明示的に「保存」した SQL クエリ（お気に入り含む）に関する契約を
 * 定義するファイル。history.ts の自動記録された実行履歴とは異なり、
 * こちらはユーザーが名前を付けて能動的に保存したものを扱う。
 */
// 保存済みクエリ 1 件分のスキーマ。
export const savedQuerySchema = z.object({
  // 一意な id。
  id: z.string().min(1),
  // クエリの表示名。
  name: z.string(),
  // クエリの説明文。
  description: z.string(),
  // 保存された SQL 文。
  statement: z.string(),
  // 実行対象の既定カタログ。
  catalog: z.string().optional(),
  // 実行対象の既定スキーマ。
  schema: z.string().optional(),
  // お気に入りフラグ。
  isFavorite: z.boolean(),
  // 作成日時。
  createdAt: isoTimestamp,
  // 最終更新日時。
  updatedAt: isoTimestamp,
});
/** 保存済みクエリの推論型。 */
export type SavedQuery = z.infer<typeof savedQuerySchema>;

/**
 * Request body for `POST /api/saved-queries`.
 * `POST /api/saved-queries`（新規保存）のリクエストボディ。
 */
export const createSavedQueryRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  statement: z.string().min(1),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  isFavorite: z.boolean().optional(),
});
/** 保存済みクエリ作成リクエストの推論型。 */
export type CreateSavedQueryRequest = z.infer<typeof createSavedQueryRequestSchema>;

/**
 * Request body for `PUT /api/saved-queries/:id`.
 * `PUT /api/saved-queries/:id`（全置換更新）のリクエストボディ。
 */
export const updateSavedQueryRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  statement: z.string().min(1),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  isFavorite: z.boolean(),
});
/** 保存済みクエリ更新リクエストの推論型。 */
export type UpdateSavedQueryRequest = z.infer<typeof updateSavedQueryRequestSchema>;

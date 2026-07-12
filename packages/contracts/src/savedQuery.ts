import { z } from 'zod';
import { isoTimestamp } from './common';
import { myPermissionSchema } from './share';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SQL_LENGTH,
} from './limits';

/**
 * SavedQuery model.
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
  /** 保存時点の実行先データソース id。省略または NULL は未指定。 */
  datasourceId: z.string().optional(),
  // お気に入りフラグ。
  isFavorite: z.boolean(),
  // 作成日時。
  createdAt: isoTimestamp,
  // 最終更新日時。
  updatedAt: isoTimestamp,
  /** 所有者 user id。共有経由で取得した場合に設定される。 */
  owner: z.string().optional(),
  /** 呼び出し元の effective permission (owner / edit / view)。 */
  myPermission: myPermissionSchema.optional(),
});
/** 保存済みクエリの推論型。 */
export type SavedQuery = z.infer<typeof savedQuerySchema>;

/**
 * Request body for `POST /api/saved-queries`.
 * `POST /api/saved-queries`（新規保存）のリクエストボディ。
 */
export const createSavedQueryRequestSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  statement: z.string().min(1).max(MAX_SQL_LENGTH),
  catalog: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  schema: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  datasourceId: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  isFavorite: z.boolean().optional(),
});
/** 保存済みクエリ作成リクエストの推論型。 */
export type CreateSavedQueryRequest = z.infer<typeof createSavedQueryRequestSchema>;

/**
 * Request body for `PUT /api/saved-queries/:id`.
 * `PUT /api/saved-queries/:id`（全置換更新）のリクエストボディ。
 */
export const updateSavedQueryRequestSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH),
  statement: z.string().min(1).max(MAX_SQL_LENGTH),
  catalog: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  schema: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  datasourceId: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  isFavorite: z.boolean(),
});
/** 保存済みクエリ更新リクエストの推論型。 */
export type UpdateSavedQueryRequest = z.infer<typeof updateSavedQueryRequestSchema>;

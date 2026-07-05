/**
 * 保存済みクエリとノートブックのユーザー間共有に関する契約を定義するファイル。
 * 共有先 (user / group / role) と permission (view / edit) のスキーマ、
 * 共有一覧の更新リクエスト、呼び出し元の effective permission を表す型を提供する。
 */
import { z } from 'zod';
import { isoTimestamp } from './common';

/** 共有先の種別。user はユーザー id、group は SSO グループ、role は RBAC ロール名。 */
export const shareSubjectTypeSchema = z.enum(['user', 'group', 'role']);
/** 共有先種別の推論型。 */
export type ShareSubjectType = z.infer<typeof shareSubjectTypeSchema>;

/** 共有 permission。view は参照のみ、edit は更新も可能。 */
export const sharePermissionSchema = z.enum(['view', 'edit']);
/** 共有 permission の推論型。 */
export type SharePermission = z.infer<typeof sharePermissionSchema>;

/** 呼び出し元がドキュメントに対して持つ effective permission。 */
export const myPermissionSchema = z.enum(['owner', 'edit', 'view']);
/** effective permission の推論型。 */
export type MyPermission = z.infer<typeof myPermissionSchema>;

/** ドキュメントに対する共有エントリ 1 件。 */
export const documentShareSchema = z.object({
  subjectType: shareSubjectTypeSchema,
  subjectValue: z.string().min(1).max(200),
  permission: sharePermissionSchema,
  createdAt: isoTimestamp,
});
/** 共有エントリの推論型。 */
export type DocumentShare = z.infer<typeof documentShareSchema>;

const shareInputSchema = z.object({
  subjectType: shareSubjectTypeSchema,
  subjectValue: z.string().min(1).max(200),
  permission: sharePermissionSchema,
});

/** 共有一覧を全置換する PUT リクエストボディ。 */
export const updateSharesRequestSchema = z
  .object({
    shares: z.array(shareInputSchema).max(50),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, share] of value.shares.entries()) {
      const key = `${share.subjectType}:${share.subjectValue}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate share subject at index ${index}`,
          path: ['shares', index],
        });
        return;
      }
      seen.add(key);
    }
  });
/** 共有一覧更新リクエストの推論型。 */
export type UpdateSharesRequest = z.infer<typeof updateSharesRequestSchema>;

/** GET /:id/shares のレスポンスボディ。 */
export const listDocumentSharesResponseSchema = z.object({
  shares: z.array(documentShareSchema),
});
/** 共有一覧レスポンスの推論型。 */
export type ListDocumentSharesResponse = z.infer<typeof listDocumentSharesResponseSchema>;

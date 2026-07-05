import { z } from 'zod';

/** GitHub 連携で扱うドキュメント種別。 */
export const documentGitTypeSchema = z.enum([
  'saved_query',
  'notebook',
  'workflow',
  'alert',
  'dashboard',
]);
export type DocumentGitType = z.infer<typeof documentGitTypeSchema>;

/** ドキュメントの Git 承認状態。 */
export const documentGitStatusSchema = z.enum(['unlinked', 'in_review', 'approved', 'modified']);
export type DocumentGitStatus = z.infer<typeof documentGitStatusSchema>;

/** `GET /api/github/status` のレスポンス。 */
export const githubStatusResponseSchema = z.object({
  enabled: z.boolean(),
  connected: z.boolean(),
  login: z.string().optional(),
  repo: z.string().optional(),
  governance: z.enum(['off', 'on']),
});
export type GithubStatusResponse = z.infer<typeof githubStatusResponseSchema>;

/** `GET /api/github/documents/:type/:id/status` のレスポンス。 */
export const githubDocumentStatusResponseSchema = z.object({
  status: documentGitStatusSchema,
  path: z.string().optional(),
  branch: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().optional(),
  approvedCommit: z.string().optional(),
  repo: z.string().optional(),
  htmlUrl: z.string().url().optional(),
  connected: z.boolean().optional(),
  stale: z.boolean().optional(),
});
export type GithubDocumentStatusResponse = z.infer<typeof githubDocumentStatusResponseSchema>;

/** `POST /api/github/documents/:type/:id/push` のリクエスト。 */
export const githubDocumentPushRequestSchema = z.object({
  message: z.string().min(1).optional(),
});
export type GithubDocumentPushRequest = z.infer<typeof githubDocumentPushRequestSchema>;

/** `POST /api/github/documents/:type/:id/push` のレスポンス。 */
export const githubDocumentPushResponseSchema = z.object({
  branch: z.string(),
  path: z.string(),
  commitSha: z.string(),
  compareUrl: z.string().url(),
});
export type GithubDocumentPushResponse = z.infer<typeof githubDocumentPushResponseSchema>;

/** `POST /api/github/documents/:type/:id/pr` のリクエスト。 */
export const githubDocumentPrRequestSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
});
export type GithubDocumentPrRequest = z.infer<typeof githubDocumentPrRequestSchema>;

/** `POST /api/github/documents/:type/:id/pr` のレスポンス。 */
export const githubDocumentPrResponseSchema = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
});
export type GithubDocumentPrResponse = z.infer<typeof githubDocumentPrResponseSchema>;

/** `POST /api/github/documents/:type/:id/pull` のレスポンス。 */
export const githubDocumentPullResponseSchema = z.object({
  pulled: z.literal(true),
  commit: z.string(),
  status: documentGitStatusSchema,
});
export type GithubDocumentPullResponse = z.infer<typeof githubDocumentPullResponseSchema>;

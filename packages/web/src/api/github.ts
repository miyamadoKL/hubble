// GitHub 連携 (接続状態、ドキュメントの push / PR / 承認ステータス) の API
// クライアントファイル。各関数は apiFetch の薄いラッパーであり、レスポンスを
// @hubble/contracts の zod スキーマで検証する。機能無効 (GITHUB_REPO 未設定) の
// サーバーは 404 GITHUB_DISABLED を返すため、グローバルステータス取得はそれを
// 「無効」として吸収する。

import {
  apiRoutes,
  githubDocumentPrResponseSchema,
  githubDocumentPushResponseSchema,
  githubDocumentStatusResponseSchema,
  githubStatusResponseSchema,
  type DocumentGitType,
  type GithubDocumentPrResponse,
  type GithubDocumentPushResponse,
  type GithubDocumentStatusResponse,
  type GithubStatusResponse,
} from '@hubble/contracts';
import { apiFetch, ApiClientError } from './client';

/**
 * `GET /api/github/status` を呼び出し、連携機能の有効状態と自分の接続状態を返す。
 * サーバー側で機能が無効な場合 (404 GITHUB_DISABLED) は enabled=false として返す。
 * @returns 連携の有効/接続状態 (無効時は { enabled: false, connected: false })。
 */
export async function getGithubStatus(): Promise<GithubStatusResponse> {
  try {
    return await apiFetch(githubStatusResponseSchema, apiRoutes.githubStatus());
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) {
      return { enabled: false, connected: false, governance: 'off' };
    }
    throw err;
  }
}

/** GitHub OAuth 接続を開始する URL (ブラウザ遷移で使う)。 */
export function githubConnectUrl(): string {
  return apiRoutes.githubConnect();
}

/**
 * `DELETE /api/github/connection` を呼び出し、GitHub 接続を解除する。
 * @throws {ApiClientError} リクエスト失敗時。
 */
export async function disconnectGithub(): Promise<void> {
  const res = await fetch(apiRoutes.githubConnection(), { method: 'DELETE' });
  if (!res.ok) throw new ApiClientError(res.status, { code: 'HTTP_ERROR', message: 'Failed' });
}

/**
 * `GET /api/github/documents/:type/:id/status` を呼び出し、ドキュメントの
 * Git 承認ステータス (unlinked / in_review / approved / modified) を返す。
 * @param type ドキュメント種別。
 * @param id ドキュメント id。
 */
export function getDocumentGitStatus(
  type: DocumentGitType,
  id: string,
): Promise<GithubDocumentStatusResponse> {
  return apiFetch(githubDocumentStatusResponseSchema, apiRoutes.githubDocumentStatus(type, id));
}

/**
 * `POST /api/github/documents/:type/:id/push` を呼び出し、ドキュメントを
 * feature ブランチへ push する (コミットは接続中ユーザー名義)。
 * @param type ドキュメント種別。
 * @param id ドキュメント id。
 * @param message コミットメッセージ (省略時はサーバー既定)。
 */
export function pushDocumentToGithub(
  type: DocumentGitType,
  id: string,
  message?: string,
): Promise<GithubDocumentPushResponse> {
  return apiFetch(githubDocumentPushResponseSchema, apiRoutes.githubDocumentPush(type, id), {
    method: 'POST',
    body: message ? { message } : {},
  });
}

/**
 * `POST /api/github/documents/:type/:id/pr` を呼び出し、push 済みブランチから
 * PR を作成する (既存の open PR があればそれを返す)。
 * @param type ドキュメント種別。
 * @param id ドキュメント id。
 */
export function createDocumentPullRequest(
  type: DocumentGitType,
  id: string,
): Promise<GithubDocumentPrResponse> {
  return apiFetch(githubDocumentPrResponseSchema, apiRoutes.githubDocumentPr(type, id), {
    method: 'POST',
    body: {},
  });
}

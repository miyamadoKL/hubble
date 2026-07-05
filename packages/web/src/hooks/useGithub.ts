// GitHub 連携向けの TanStack Query hooks。
// グローバル接続状態、ドキュメント単位の承認ステータス取得、push / PR 作成の
// mutation を提供する。ステータスはサーバー側で TTL キャッシュされるため、
// クライアント側の staleTime は控えめでよい。

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  DocumentGitType,
  GithubDocumentStatusResponse,
  GithubStatusResponse,
} from '@hubble/contracts';
import {
  createDocumentPullRequest,
  disconnectGithub,
  getDocumentGitStatus,
  getGithubStatus,
  pullDocumentFromMain,
  pushDocumentToGithub,
} from '../api/github';

// グローバル接続状態のキャッシュキー。
const githubStatusKey = ['github', 'status'] as const;
// ドキュメント単位のステータスキャッシュキー。
const docStatusKey = (type: DocumentGitType, id: string) => ['github', 'doc', type, id] as const;

/** 連携機能の有効状態と自分の接続状態を取得する hook。 */
export function useGithubStatus(): UseQueryResult<GithubStatusResponse> {
  return useQuery({
    queryKey: githubStatusKey,
    queryFn: getGithubStatus,
    // 無効な環境で繰り返し叩かないよう長めに保持する。
    staleTime: 60_000,
  });
}

/**
 * ドキュメントの Git 承認ステータスを取得する hook。
 * @param type ドキュメント種別。
 * @param id ドキュメント id。null または連携無効時はクエリを無効化する。
 * @param enabled 連携機能が有効かどうか (useGithubStatus の結果を渡す)。
 */
export function useDocumentGitStatus(
  type: DocumentGitType,
  id: string | null,
  enabled: boolean,
): UseQueryResult<GithubDocumentStatusResponse> {
  return useQuery({
    queryKey: docStatusKey(type, id ?? ''),
    queryFn: () => getDocumentGitStatus(type, id!),
    enabled: enabled && id !== null,
    staleTime: 30_000,
  });
}

/** GitHub 接続を解除する mutation hook。 */
export function useDisconnectGithub() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: disconnectGithub,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['github'] }),
  });
}

/** ドキュメントを push する mutation hook。成功時に該当ステータスを無効化する。 */
export function usePushDocument(type: DocumentGitType, id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (message?: string) => pushDocumentToGithub(type, id, message),
    onSuccess: () => void client.invalidateQueries({ queryKey: docStatusKey(type, id) }),
  });
}

/** PR を作成する mutation hook。成功時に該当ステータスを無効化する。 */
export function useCreateDocumentPr(type: DocumentGitType, id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => createDocumentPullRequest(type, id),
    onSuccess: () => void client.invalidateQueries({ queryKey: docStatusKey(type, id) }),
  });
}

// ドキュメント種別ごとの一覧/詳細キャッシュキーの先頭部分。pull 後に本体を再取得させる。
const DOC_CONTENT_KEYS: Record<DocumentGitType, readonly string[]> = {
  saved_query: ['saved-queries'],
  notebook: ['notebooks'],
  workflow: ['workflows'],
  alert: ['alerts'],
  dashboard: ['dashboards'],
};

/**
 * main の内容へ強制的に戻す (pull) mutation hook。
 * 成功時に Git ステータスとドキュメント本体のキャッシュを無効化する。
 */
export function usePullDocument(type: DocumentGitType, id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => pullDocumentFromMain(type, id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: docStatusKey(type, id) });
      void client.invalidateQueries({ queryKey: DOC_CONTENT_KEYS[type] });
    },
  });
}

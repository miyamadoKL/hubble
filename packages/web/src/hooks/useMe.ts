// Current identity (`GET /api/me`) via TanStack Query (design.md §11). Drives
// the TopBar user chip (hidden in `none` mode) and is the canonical signal for
// the global "authentication required" screen: a 401 here means the proxy
// session is missing or expired.
//
// --- ファイル概要（日本語） ---
// 現在ログインしているユーザーの情報（GET /api/me）を TanStack Query 経由で取得するフック。
// 取得結果は TopBar のユーザーチップ表示（認証モードが 'none' のときは非表示）に使われるほか、
// 「未認証（401）かどうか」を判定する唯一の正規ソースとして、認証必須画面の表示制御にも
// 使われる。ここで 401（UNAUTHENTICATED）が返るのは、リバースプロキシのセッションが
// 存在しないか期限切れであることを意味する。

import { useQuery } from '@tanstack/react-query';
import { UNAUTHENTICATED, type MeResponse } from '@hubble/contracts';
import { ApiClientError, fetchMe } from '../api/client';

// TanStack Query のキャッシュキー。ユーザー情報はグローバルに1種類しかないため単一のキーで管理する。
export const meQueryKey = ['me'] as const;

/**
 * 現在の認証済みユーザー情報（MeResponse）を取得する hook。GET /api/me を fetchMe
 * （../api/client）経由で呼び出す。staleTime: Infinity により、明示的な invalidate が
 * ない限り再フェッチしない（ログイン状態はセッション中は基本的に変わらない前提）。
 *
 * retry の挙動に注意: エラーが ApiClientError かつ UNAUTHENTICATED コード（401 相当）の
 * 場合はリトライしない（＝すぐに未認証として扱い、認証必須画面へ誘導する）。
 * それ以外の一時的なエラーの場合は1回だけ再試行する。
 *
 * @returns TanStack Query の結果オブジェクト。data が MeResponse、error が ApiClientError。
 */
export function useMe() {
  return useQuery<MeResponse, ApiClientError>({
    queryKey: meQueryKey,
    queryFn: fetchMe,
    staleTime: Infinity,
    // Don't hammer the server on a 401 — surface it to the auth screen instead.
    // 401（未認証）の場合はリトライしてもサーバーに負荷をかけるだけで解決しないため、
    // 即座に諦めて認証必須画面にエラーを伝播させる。それ以外のエラーは1回だけ再試行する。
    retry: (failureCount, error) => {
      if (error instanceof ApiClientError && error.detail.code === UNAUTHENTICATED) return false;
      return failureCount < 1;
    },
  });
}

/** True when the `/api/me` request failed with the UNAUTHENTICATED code. */
/**
 * 与えられたエラーが `/api/me` リクエストの UNAUTHENTICATED（未認証）失敗であるかどうかを
 * 判定するヘルパー関数。useMe() の error をこの関数に渡すことで、認証必須画面を
 * 表示すべきかどうかを判断できる。
 *
 * @param error - 判定対象のエラー（型は unknown。ApiClientError 以外の可能性も考慮）。
 * @returns ApiClientError であり、かつそのエラーコードが UNAUTHENTICATED の場合に true。
 */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiClientError && error.detail.code === UNAUTHENTICATED;
}

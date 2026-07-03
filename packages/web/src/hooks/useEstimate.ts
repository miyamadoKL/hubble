// Live Query Guard estimate hook (Query Guard feature).
//
// Fetches `POST /api/queries/estimate` for a single resolved statement via
// TanStack Query, keyed by (statement, catalog, schema) so the same statement is
// never re-estimated within the cache window — both across cells and across the
// debounced keystrokes of one cell. The server holds a 30s estimate cache; we
// mirror it with `staleTime` so a re-render or a repeated statement is a no-op.
//
// The *decision to call* lives in the caller (SqlCell): it only passes a
// `statement` once the cell parses clean, all variables resolve, and the guard
// is on. Passing `statement: null` keeps the query disabled (so a syntax error
// or `mode=off` simply never fetches).
//
// --- ファイル概要（日本語） ---
// Query Guard 機能向けの「実行前スキャン量見積もり」を取得する hook。
// クエリを実際に実行する前に、SQL 文がどれくらいのデータをスキャンするかをサーバー側
// （POST /api/queries/estimate）に問い合わせ、その結果（EstimateResult）を使って
// SqlCell 側で警告表示やブロック判定を行う。この見積もりは
// 「文字列（statement）＋ catalog ＋ schema」の組み合わせをキャッシュキーとするため、
// 同じ文を何度見積もっても（別セルでも、同一セル内の debounce 後の再評価でも）
// キャッシュが効いている間は再リクエストされない。サーバー側にも30秒の見積もりキャッシュが
// あるため、クライアント側の staleTime もそれに合わせて30秒にしている。
// なお「見積もりリクエストを送るかどうか」の判断は呼び出し元（SqlCell）が行う。
// SqlCell は SQL のパースが成功し、変数がすべて解決し、Query Guard が有効なときのみ
// statement を渡す。statement に null を渡すとクエリは無効化（enabled: false）され、
// 構文エラー時や mode=off のときにリクエストが飛ばないようになっている。

import { useQuery } from '@tanstack/react-query';
import type { EstimateResult } from '@hubble/contracts';
import { estimateQuery } from '../execution/estimate';

/** Mirror the server's 30s estimate cache so identical statements don't refetch. */
/** サーバー側の30秒見積もりキャッシュに合わせた staleTime。同じ statement なら再取得しない。 */
export const ESTIMATE_STALE_MS = 30_000;

/**
 * useEstimate に渡すパラメータ。statement、catalog、schema の組み合わせで
 * どの見積もりリクエストか（＝キャッシュのキー）が決まる。
 */
export interface UseEstimateParams {
  /** The exact statement to estimate (post variable-substitution + auto-LIMIT), or null to disable. */
  /**
   * 見積もり対象となる、変数置換とLIMIT自動付与が済んだ最終的な SQL 文。
   * null を渡すとクエリが無効化され、リクエストは発行されない
   * （SQL がパースエラー、または Query Guard が off のとき呼び出し元がこれを渡す）。
   */
  statement: string | null;
  catalog?: string;
  schema?: string;
  datasourceId?: string;
  /** false のときリクエスト自体を送らない（costEstimate 非対応データソース向け）。 */
  enabled?: boolean;
}

/** TanStack Query key for an estimate — stable per resolved statement + context. */
/**
 * 見積もりリクエスト用の TanStack Query キャッシュキーを生成する。
 * catalog / schema / statement の組み合わせごとに一意になるよう配列で表現しており、
 * 同じ組み合わせであればキャッシュがヒットして再フェッチされない。
 */
export function estimateQueryKey(params: UseEstimateParams) {
  return [
    'estimate',
    params.datasourceId ?? '',
    params.catalog ?? '',
    params.schema ?? '',
    params.statement,
  ] as const;
}

/**
 * Live estimate for the supplied statement. Disabled (no request) when
 * `statement` is null. Returns the standard TanStack Query result; the data is
 * an `EstimateResult` once it resolves.
 */
/**
 * 指定した SQL 文に対するライブな（実行前の）スキャン量見積もりを取得する hook。
 *
 * @param params - 見積もり対象の statement と catalog/schema のコンテキスト。
 *   statement が null または空文字の場合はクエリが無効化され（enabled: false）、
 *   ネットワークリクエストは発生しない。
 * @returns TanStack Query の標準的な結果オブジェクト。データが解決すると
 *   `data` に `EstimateResult`（../execution/estimate 経由で estimateQuery が
 *   POST /api/queries/estimate を呼び出した結果）が入る。
 *
 * 内部的には estimateQuery（../execution/estimate）を queryFn として渡し、
 * useConfig.ts の useGuardConfig が返す Query Guard 設定と組み合わせて
 * SqlCell 側の警告 UI に使われる。
 */
export function useEstimate(params: UseEstimateParams) {
  // statement が null または空文字なら見積もりを行う意味がないため、クエリ自体を無効化する。
  const enabled =
    params.enabled !== false &&
    params.statement !== null &&
    params.statement.length > 0;
  return useQuery<EstimateResult>({
    queryKey: estimateQueryKey(params),
    queryFn: () =>
      estimateQuery({
        statement: params.statement as string,
        catalog: params.catalog,
        schema: params.schema,
        datasourceId: params.datasourceId,
      }),
    enabled,
    // サーバー側の見積もりキャッシュ（30秒）に合わせて、同じキーへの再フェッチを抑制する。
    staleTime: ESTIMATE_STALE_MS,
    // A live estimate is advisory — a transient failure should fall back to the
    // server's enforce wall, not spam retries while the user types.
    // ライブ見積もりはあくまで参考情報（advisory）であり、失敗しても実行自体は
    // サーバー側の enforce（強制ブロック）ロジックに委ねればよいため、
    // ユーザーが入力中に何度もリトライしてリクエストを増やさないよう retry は無効にする。
    retry: false,
    // Keep the previous estimate visible while a new (debounced) statement
    // estimates, avoiding a flash to empty between keystrokes.
    // 新しい（debounce 後の）statement の見積もり中も、直前の見積もり結果を表示し続けることで、
    // キー入力のたびに表示が一瞬空になる「ちらつき」を防ぐ。
    placeholderData: (prev) => prev,
  });
}

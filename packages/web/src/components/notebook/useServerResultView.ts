/**
 * useServerResultView.ts
 *
 * ResultGrid の server-side モードを支えるフック。クライアントに全行が
 * 載っていない結果（履歴から開いた永続化結果など）に対して filter / sort を
 * 指定されたとき、`POST /api/queries/:id/rows/search` をデバウンス付きで
 * 呼び出し、サーバー側で絞り込んだページを返す。
 */
import { useQuery } from '@tanstack/react-query';
import type { ResultSort } from '@hubble/contracts';
import { searchQueryRows } from '../../execution/api';
import type { ResultRow } from '../../execution';

// filter 入力の連続変更をまとめるデバウンス時間（ミリ秒）。
const DEBOUNCE_MS = 300;
// 1 回の検索で取得する最大行数。既存の rows API の limit 上限と同じ。
const SEARCH_PAGE_LIMIT = 10_000;

/** server-side 検索の現在状態。 */
export interface ServerResultView {
  /** サーバーから返った絞り込み済みの行（最大 SEARCH_PAGE_LIMIT 行）。 */
  rows: ResultRow[];
  /** フィルタ適用後の総行数。 */
  totalMatched: number;
  /** 検索リクエストが飛んでいる間 true。 */
  loading: boolean;
  /** 直近の検索が失敗したときのメッセージ。 */
  error?: string;
}

const EMPTY: ServerResultView = { rows: [], totalMatched: 0, loading: false };

/** React Query のキャンセルに追従しながら検索開始を遅延させる。 */
function waitForDebounce(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, DEBOUNCE_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * server-side filter / sort の結果ページを取得するフック。
 *
 * @param queryId - 対象クエリ id（未確定なら undefined）。
 * @param active - server-side モードが有効で、かつ filter か sort が指定されているとき true。
 * @param filter - 全列部分一致の検索文字列（空文字は条件なし）。
 * @param sort - ソート指定（null は元の行順）。
 * @returns 検索結果の現在状態。active が false のときは空状態を返す。
 */
export function useServerResultView(
  queryId: string | undefined,
  active: boolean,
  filter: string,
  sort: ResultSort | null,
): ServerResultView {
  const search = filter.trim();
  const query = useQuery({
    queryKey: ['server-result-view', active, queryId ?? '', search, sort?.columnIndex, sort?.dir],
    queryFn: async ({ signal }) => {
      await waitForDebounce(signal);
      return searchQueryRows(
        queryId as string,
        {
          ...(search !== '' ? { search } : {}),
          ...(sort !== null ? { sort } : {}),
          offset: 0,
          limit: SEARCH_PAGE_LIMIT,
        },
        signal,
      );
    },
    enabled: active && queryId !== undefined,
    placeholderData: (previous) => previous,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: 'always',
  });

  if (!active || queryId === undefined) return EMPTY;
  return {
    rows: query.isError ? [] : ((query.data?.rows ?? []) as ResultRow[]),
    totalMatched: query.isError ? 0 : (query.data?.totalMatched ?? 0),
    loading: query.isFetching,
    ...(query.error ? { error: query.error.message } : {}),
  };
}

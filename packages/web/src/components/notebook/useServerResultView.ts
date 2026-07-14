/**
 * useServerResultView.ts
 *
 * ResultGrid の server-side モードを支えるフック。クライアントに全行が
 * 載っていない結果（履歴から開いた永続化結果など）に対して filter / sort を
 * 指定されたとき、`POST /api/queries/:id/rows/search` をデバウンス付きで
 * 呼び出し、サーバー側で絞り込んだページを返す。
 */
import { useEffect, useRef, useState } from 'react';
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

/** 検索条件ごとに保存するレスポンス（key は条件の識別子）。 */
interface StoredResult {
  key: string;
  rows: ResultRow[];
  totalMatched: number;
  error?: string;
}

const EMPTY: ServerResultView = { rows: [], totalMatched: 0, loading: false };

/**
 * server-side filter / sort の結果ページを取得するフック。
 *
 * loading は「保存済みレスポンスの条件 key が現在の条件と一致しない」ことから
 * 導出する（effect 内で同期的に setState しないための構造）。
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
  const sortKey = sort ? `${sort.columnIndex}:${sort.dir}` : '';
  // 現在の検索条件の識別子。レスポンスの取捨と loading の導出に使う。
  const key = `${queryId ?? ''}|${search}|${sortKey}`;

  const [result, setResult] = useState<StoredResult>({ key: '', rows: [], totalMatched: 0 });
  // 遅れて届いた古いレスポンスを捨てるため、最新の条件 key を ref に持つ。
  // render 中の書き換えは禁止されているため、effect 内で更新する。
  const keyRef = useRef(key);

  useEffect(() => {
    keyRef.current = key;
    if (!active || queryId === undefined) return;
    const requestKey = key;
    const controller = new AbortController();
    // filter のタイプ中に毎キー発火しないよう、デバウンスしてから検索する。
    const timer = setTimeout(() => {
      searchQueryRows(
        queryId,
        {
          ...(search !== '' ? { search } : {}),
          ...(sort !== null ? { sort } : {}),
          offset: 0,
          limit: SEARCH_PAGE_LIMIT,
        },
        controller.signal,
      )
        .then((page) => {
          // 条件が変わった後に届いたレスポンスは破棄する。
          if (controller.signal.aborted || keyRef.current !== requestKey) return;
          setResult({
            key: requestKey,
            rows: page.rows as ResultRow[],
            totalMatched: page.totalMatched,
          });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || keyRef.current !== requestKey) return;
          setResult({
            key: requestKey,
            rows: [],
            totalMatched: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // sort オブジェクトは呼び出し側で毎レンダー新しい参照になりうるため、
    // 値ベースの key を依存に使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryId, active, key]);

  if (!active || queryId === undefined) return EMPTY;
  if (result.key === key) {
    return {
      rows: result.rows,
      totalMatched: result.totalMatched,
      loading: false,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
  // 現在の条件に対するレスポンスが未着: 前回の行を出しつつ loading を立てる。
  return { rows: result.rows, totalMatched: result.totalMatched, loading: true };
}

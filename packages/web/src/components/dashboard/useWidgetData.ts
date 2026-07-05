/**
 * useWidgetData.ts
 *
 * ダッシュボードの query widget が参照先の保存済みクエリを実行し、
 * 結果 (columns と rows) を取得するための hook。
 * 既存のクエリ実行 API (POST /api/queries → スナップショットのポーリング →
 * 行ページ取得) に合流するため、datasource allowlist などの実行時認可は
 * サーバー側でそのまま強制される。ノートブックの executionStore は
 * セル単位のライフサイクル管理に特化しているため使わず、widget 用の
 * 単純な「実行して完了を待って行を読む」フローをここに閉じる。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueryColumn } from '@hubble/contracts';
import { getSavedQuery } from '../../api/savedQueries';
import { createQuery, fetchQueryRows, fetchQuerySnapshot } from '../../execution/api';
import type { ResultRow } from '../../execution';

/** widget が一度に読み込む最大行数 (チャートとテーブル表示には十分な量)。 */
const WIDGET_MAX_ROWS = 1000;
/** スナップショットのポーリング間隔 (ミリ秒)。 */
const POLL_INTERVAL_MS = 800;
/** これ以上待っても終わらないクエリは打ち切る (ミリ秒)。 */
const POLL_TIMEOUT_MS = 120_000;

/** widget のデータ取得状態。 */
export interface WidgetData {
  /** 読み込み中 (初回または手動リフレッシュ中) かどうか。 */
  loading: boolean;
  /** 取得失敗時のエラーメッセージ (参照先クエリの消失や実行エラーを含む)。 */
  error: string | null;
  /** 結果の列定義。 */
  columns: QueryColumn[];
  /** 結果の行データ。 */
  rows: ResultRow[];
  /** 参照している保存クエリの名前 (タイトル未設定時の表示に使う)。 */
  queryName: string | null;
  /** クエリを再実行してデータを更新する。 */
  refresh: () => void;
}

// クエリの終端状態の集合。これらに達したらポーリングを止める。
const TERMINAL_STATES = new Set(['finished', 'failed', 'canceled']);

/**
 * 保存済みクエリを実行して結果を取得する hook。
 * マウント時に自動実行し、`refresh()` で再実行できる。
 * @param savedQueryId 参照する保存済みクエリの id。
 */
export function useWidgetData(savedQueryId: string): WidgetData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<QueryColumn[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [queryName, setQueryName] = useState<string | null>(null);
  // 実行の世代番号。アンマウント後や refresh 後に古い実行の結果を反映しないためのガード。
  const generationRef = useRef(0);

  const run = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      // 参照先の保存クエリを解決する。消えている/共有されていない場合はここで 404 になる。
      const sq = await getSavedQuery(savedQueryId);
      if (generation !== generationRef.current) return;
      setQueryName(sq.name);

      // 既存のクエリ実行 API に合流する (実行時認可はサーバー側で強制される)。
      const { queryId } = await createQuery({
        statement: sq.statement,
        catalog: sq.catalog ?? undefined,
        schema: sq.schema ?? undefined,
        datasourceId: sq.datasourceId ?? undefined,
        maxRows: WIDGET_MAX_ROWS,
      });

      // 終端状態に達するまでスナップショットをポーリングする。
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let snapshot = await fetchQuerySnapshot(queryId);
      while (!TERMINAL_STATES.has(snapshot.state)) {
        if (generation !== generationRef.current) return;
        if (Date.now() > deadline) {
          throw new Error('Query timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        snapshot = await fetchQuerySnapshot(queryId);
      }
      if (generation !== generationRef.current) return;
      if (snapshot.state !== 'finished') {
        throw new Error(snapshot.error?.message ?? `Query ${snapshot.state}`);
      }

      // バッファ済みの行をまとめて取得する。
      const page = await fetchQueryRows(queryId, 0, WIDGET_MAX_ROWS);
      if (generation !== generationRef.current) return;
      setColumns(snapshot.columns ?? []);
      setRows(page.rows);
      setLoading(false);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [savedQueryId]);

  // マウント時と savedQueryId 変更時に自動実行する。
  // effect 内での同期 setState (カスケード再レンダー) を避けるため、
  // 実行開始はマイクロタスクへ遅延させる。
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void run();
    });
    // アンマウント時に世代を進めることで、進行中の実行結果の反映を止める。
    return () => {
      cancelled = true;
      generationRef.current += 1;
    };
  }, [run]);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  return { loading, error, columns, rows, queryName, refresh };
}

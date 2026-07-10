/**
 * ChartPanel.tsx
 *
 * SQL セルの実行結果を表示する「チャート」タブの本体コンポーネント。
 * セルごとのチャート設定（軸に使う列や種類など）をノートブックのセル
 * （`cell.chart`、サーバーへ永続化される）から読み込み、
 * 現在のクエリ結果の列構成と突き合わせて有効な設定に補正（reconcile）したうえで、
 * 設定操作 UI（ChartControls）と実際の描画（ChartView）をまとめて表示する。
 * 行が無い、あるいは数値列が無くグラフ化できない場合はガイダンス表示に切り替える。
 */
import { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import type { QueryColumn } from '@hubble/contracts';
import { ChartControls } from './ChartControls';
import { ChartView } from './ChartView';
import { EmptyState } from '../common/EmptyState';
import { describeColumns, reconcileConfig } from '../../chart';
import { useNotebookStore } from '../../notebook/notebookStore';
import type { ResultRow } from '../../execution';

/**
 * Chart tab body (結果: チャート). Owns the per-cell config: reads
 * the stored config (or seeds a default), reconciles it against the live result
 * columns, renders the control row + ECharts canvas. When nothing is chartable
 * (no numeric column / no rows) it shows guidance instead of an empty plot.
 */
/**
 * クエリ結果をチャートとして表示するパネル。
 * @param cellId - 対象セルの ID（チャート設定をノートブックセルに保存/読込する際のキーになる）。
 * @param columns - クエリ結果の列定義一覧。
 * @param rows - クエリ結果の行データ一覧。
 */
export function ChartPanel({
  cellId,
  columns,
  rows,
  rowsVersion,
}: {
  cellId: string;
  columns: QueryColumn[];
  rows: ReadonlyArray<ResultRow>;
  rowsVersion?: number;
}) {
  // このセルに保存済みのチャート設定を購読する（未設定なら undefined）。
  // 設定はノートブックセルの `chart` フィールドとして保持され、
  // notebook 本体のオートセーブに乗ってサーバーへ永続化される。
  const stored = useNotebookStore((s) => {
    const ownerId = s.openIds.find((nbId) =>
      s.open[nbId]?.notebook.cells.some((c) => c.id === cellId),
    );
    if (!ownerId) return undefined;
    return s.open[ownerId]?.notebook.cells.find((c) => c.id === cellId)?.chart;
  });
  // チャート設定を更新するためのストアアクション。
  const setConfig = useNotebookStore((s) => s.setCellChart);

  // 列定義を「型（数値/文字列/日時など）付き」の記述情報に変換する。columns が変わらない限り再計算しない。
  const cols = useMemo(() => describeColumns(columns), [columns]);
  // Reconcile the stored config against the current columns (drops stale refs,
  // seeds a default the first time). Memoized on the stored config + columns.
  // 保存済み設定を現在の列構成と突き合わせて補正する。存在しない列への参照を落とし、
  // 初回は数値列などから既定のチャート設定を自動生成する。stored/cols が変わらない限り再計算しない。
  const config = useMemo(() => reconcileConfig(stored ?? null, cols), [stored, cols]);

  // {/* 結果行が0件のときはチャートを描画せず、案内メッセージのみ表示する */}
  if (rows.length === 0) {
    return (
      <div className="bg-surface-sunken">
        <EmptyState
          icon={BarChart3}
          title="No rows to chart"
          description="Run a query that returns rows to plot a chart."
          compact
        />
      </div>
    );
  }

  // {/* 行はあるがグラフ化できる設定が得られない（数値列が無い等）場合も案内メッセージを表示する */}
  if (!config) {
    return (
      <div className="bg-surface-sunken">
        <EmptyState
          icon={BarChart3}
          title="Nothing to plot"
          description="A chart needs at least one numeric column. This result has none."
          compact
        />
      </div>
    );
  }

  // {/* 通常時：チャート種類や軸などを操作する ChartControls と、実際の描画を行う ChartView を並べて表示 */}
  return (
    <div>
      <ChartControls cols={cols} config={config} onChange={(next) => setConfig(cellId, next)} />
      <ChartView columns={columns} rows={rows} rowsVersion={rowsVersion} config={config} />
    </div>
  );
}

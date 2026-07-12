/**
 * QueryWidgetBody.tsx
 *
 * query widget の本文表示。dashboard の共有 query 実行で取得した結果を viz 設定
 * (table / chart / counter) に応じて描画する。参照先クエリの消失や
 * 実行エラーはパネル単位のエラー表示に閉じ、ダッシュボード全体は壊さない
 * (Redash の RestrictedWidget と同じ発想)。
 */
import { lazy, Suspense, useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { QueryColumn, QueryWidget } from '@hubble/contracts';
import { Spinner } from '../common/Spinner';
import { describeColumns, reconcileConfig, toLabel, toNumber } from '../../chart';
import type { ResultRow } from '../../execution';

const ChartView = lazy(() =>
  import('../notebook/ChartView').then((module) => ({ default: module.ChartView })),
);

/** widget テーブル表示の最大行数 (パネルサイズに収まる範囲での上限)。 */
const TABLE_MAX_ROWS = 100;

/** パネル単位のエラー表示。 */
function WidgetError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <TriangleAlert size={18} strokeWidth={1.75} className="text-warning" />
      <p className="max-w-full text-xs break-words text-ink-muted">{message}</p>
    </div>
  );
}

/** 単純なテーブル表示 (ノートブックの ResultGrid は実行ストア結合のため使わない)。 */
function WidgetTable({ columns, rows }: { columns: QueryColumn[]; rows: ResultRow[] }) {
  const view = rows.slice(0, TABLE_MAX_ROWS);
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-surface-base">
          <tr>
            {columns.map((c) => (
              <th
                key={c.name}
                className="border-b border-border-base px-2 py-1.5 text-left font-semibold whitespace-nowrap text-ink-muted"
              >
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.map((row, i) => (
            <tr key={i} className="odd:bg-surface-sunken/40">
              {columns.map((_, j) => (
                <td
                  key={j}
                  className="border-b border-border-subtle px-2 py-1 font-mono whitespace-nowrap text-ink-strong"
                >
                  {toLabel(row[j])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > TABLE_MAX_ROWS && (
        <p className="px-2 py-1.5 font-mono text-2xs text-ink-subtle">
          Showing first {TABLE_MAX_ROWS} of {rows.length} rows
        </p>
      )}
    </div>
  );
}

/** counter 表示: 先頭行の指定カラム値を大きく描画する KPI パネル。 */
function WidgetCounter({
  widget,
  columns,
  rows,
}: {
  widget: QueryWidget;
  columns: QueryColumn[];
  rows: ResultRow[];
}) {
  const idx = widget.counter?.columnIndex ?? 0;
  const column = columns[idx];
  if (!column) {
    return <WidgetError message={`Column index ${idx} not found in the result`} />;
  }
  const raw = rows[0]?.[idx];
  const num = toNumber(raw);
  // 数値ならロケール区切りで整形し、そうでなければ文字列表示にフォールバックする。
  const display = num !== null ? num.toLocaleString() : toLabel(raw);
  const label = widget.counter?.label?.trim() || column.name;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4">
      <span className="max-w-full truncate font-mono text-3xl font-semibold text-ink-strong">
        {display}
      </span>
      <span className="max-w-full truncate text-xs text-ink-muted">{label}</span>
    </div>
  );
}

/**
 * query widget の本文。取得状態 (loading / error) の分岐と viz の出し分けを行う。
 * @param widget 対象の query widget 定義。
 * @param loading データ取得中かどうか。
 * @param error 取得エラーメッセージ (null なら成功)。
 * @param columns 結果の列定義。
 * @param rows 結果の行データ。
 */
export function QueryWidgetBody({
  widget,
  loading,
  error,
  columns,
  rows,
}: {
  widget: QueryWidget;
  loading: boolean;
  error: string | null;
  columns: QueryColumn[];
  rows: ResultRow[];
}) {
  // チャート表示用に、保存済みの chart 設定を現在の列構成へ補正する。
  const cols = useMemo(() => describeColumns(columns), [columns]);
  const chartConfig = useMemo(
    () => (widget.viz === 'chart' ? reconcileConfig(widget.chart ?? null, cols) : null),
    [widget.viz, widget.chart, cols],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> Running…
      </div>
    );
  }
  if (error) {
    return <WidgetError message={error} />;
  }
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-2xs text-ink-subtle">
        No rows
      </div>
    );
  }

  if (widget.viz === 'counter') {
    return <WidgetCounter widget={widget} columns={columns} rows={rows} />;
  }
  if (widget.viz === 'chart') {
    if (!chartConfig) {
      return <WidgetError message="Nothing to plot: the result has no numeric column" />;
    }
    return (
      <div className="h-full min-h-0 p-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-muted">
              <Spinner size={14} /> Loading chart…
            </div>
          }
        >
          <ChartView columns={columns} rows={rows} config={chartConfig} fill />
        </Suspense>
      </div>
    );
  }
  return <WidgetTable columns={columns} rows={rows} />;
}

import { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import type { QueryColumn } from '@hue-fable/contracts';
import { ChartControls } from './ChartControls';
import { ChartView } from './ChartView';
import { EmptyState } from '../common/EmptyState';
import { describeColumns, reconcileConfig } from '../../chart';
import { useChartConfig, useChartConfigStore } from '../../chart/chartConfigStore';
import type { ResultRow } from '../../execution';

/**
 * Chart tab body (design.md §5 結果 — チャート). Owns the per-cell config: reads
 * the stored config (or seeds a default), reconciles it against the live result
 * columns, renders the control row + ECharts canvas. When nothing is chartable
 * (no numeric column / no rows) it shows guidance instead of an empty plot.
 */
export function ChartPanel({
  cellId,
  columns,
  rows,
}: {
  cellId: string;
  columns: QueryColumn[];
  rows: ReadonlyArray<ResultRow>;
}) {
  const stored = useChartConfig(cellId);
  const setConfig = useChartConfigStore((s) => s.set);

  const cols = useMemo(() => describeColumns(columns), [columns]);
  // Reconcile the stored config against the current columns (drops stale refs,
  // seeds a default the first time). Memoized on the stored config + columns.
  const config = useMemo(() => reconcileConfig(stored ?? null, cols), [stored, cols]);

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

  return (
    <div>
      <ChartControls cols={cols} config={config} onChange={(next) => setConfig(cellId, next)} />
      <ChartView columns={columns} rows={rows} config={config} />
    </div>
  );
}

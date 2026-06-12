import { useEffect, useRef, useState } from 'react';
import type { QueryColumn } from '@hue-fable/contracts';
import type { EChartsType } from 'echarts/core';
import { loadECharts } from '../../chart/echartsLoader';
import { buildChartOption, readChartTheme, type ChartConfig } from '../../chart';
import type { ResultRow } from '../../execution';
import { useUiStore } from '../../stores/uiStore';
import { Spinner } from '../common/Spinner';

/**
 * The ECharts canvas for a result chart (design.md §5). ECharts is loaded lazily
 * (own chunk) on first render. The option is rebuilt from rows + config + the
 * current token theme on any change, and the chart re-themes + resizes when the
 * app theme switches or the container resizes. No raw colors — every color comes
 * from `readChartTheme` (tokens.css).
 */
export function ChartView({
  columns,
  rows,
  config,
  height = 320,
}: {
  columns: QueryColumn[];
  rows: ReadonlyArray<ResultRow>;
  config: ChartConfig;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useUiStore((s) => s.theme);

  // Create the chart instance once (after echarts loads), dispose on unmount.
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void loadECharts().then((echarts) => {
      if (disposed || !hostRef.current) return;
      const chart = echarts.init(hostRef.current, undefined, { renderer: 'canvas' });
      chartRef.current = chart;
      setReady(true);
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => chart.resize());
        resizeObserver.observe(hostRef.current);
      }
    });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  // Rebuild + apply the option whenever the inputs or theme change. Reading the
  // theme here (not at mount) makes the chart follow the light/dark switch.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const option = buildChartOption({ columns, rows, config, theme: readChartTheme() });
    if (option) {
      // `notMerge` so dropping a series / switching type fully replaces the option.
      chart.setOption(option, { notMerge: true });
    } else {
      chart.clear();
    }
  }, [columns, rows, config, theme, ready]);

  return (
    <div className="relative bg-surface-sunken" data-testid="chart-canvas">
      {!ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 font-mono text-2xs text-ink-subtle">
          <Spinner size={14} /> Loading chart…
        </div>
      )}
      <div ref={hostRef} style={{ height }} className="w-full" />
    </div>
  );
}

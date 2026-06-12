// Lazy ECharts loader (design.md §5/§8 "echarts は動的 import でチャンク分離").
// Pulls only the chart + component modules we use from echarts/core so the editor
// payload stays lean, and the whole thing lands in its own rollup chunk. The
// dynamic import is cached so repeated chart renders reuse one module instance.

import type { EChartsType } from 'echarts/core';

export type { EChartsType };

let modulePromise: Promise<typeof import('echarts/core')> | null = null;

/**
 * Load echarts/core with the bars/lines/pie/scatter charts and the axis / grid /
 * tooltip / legend components registered. Returns the `echarts` namespace so the
 * caller can `init` a chart. Registration is idempotent (echarts dedupes).
 */
export async function loadECharts(): Promise<typeof import('echarts/core')> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
      ]);
      core.use([
        charts.BarChart,
        charts.LineChart,
        charts.PieChart,
        charts.ScatterChart,
        components.GridComponent,
        components.TooltipComponent,
        components.LegendComponent,
        components.DataZoomComponent,
        renderers.CanvasRenderer,
      ]);
      return core;
    })();
  }
  return modulePromise;
}

// ============================================================================
// 【ファイル概要】
// このファイルは、ECharts本体（echarts/core）と必要なチャート、コンポーネント、
// レンダラーのモジュールを動的import（コード分割）で遅延ロードする処理を担う。
// 「echarts は動的 import でチャンク分離」という方針に従い、
// エディタ本体のバンドルサイズにECHartsを含めず、チャートを実際に描画する
// タイミングで初めてロードされるようにする。
// ============================================================================
// Lazy ECharts loader ("echarts は動的 import でチャンク分離").
// Pulls only the chart + component modules we use from echarts/core so the editor
// payload stays lean, and the whole thing lands in its own rollup chunk. The
// dynamic import is cached so repeated chart renders reuse one module instance.

import type { EChartsType } from 'echarts/core';

// EChartsType はチャートインスタンスの型として呼び出し側でも使えるよう re-export する。
export type { EChartsType };

// ロード済み（またはロード中）の echarts/core モジュールを保持するキャッシュ。
// 一度ロードすれば以降の呼び出しは同じPromiseを返す（二重ロードと二重登録を防ぐ）。
let modulePromise: Promise<typeof import('echarts/core')> | null = null;

/**
 * Load echarts/core with the bars/lines/pie/scatter charts and the axis / grid /
 * tooltip / legend components registered. Returns the `echarts` namespace so the
 * caller can `init` a chart. Registration is idempotent (echarts dedupes).
 * echarts/core と、本アプリで使うチャート種別（棒、折れ線、円、散布図）および
 * 各種コンポーネント（グリッド、ツールチップ、凡例、データズーム）、
 * Canvasレンダラーを動的importで並行ロードし、echarts.use()で登録する。
 * 呼び出し側はこの関数が返す echarts namespace を使って `init()` し、
 * チャートインスタンスを生成する。登録処理はecharts側で冪等に扱われるため、
 * 複数回呼び出しても問題ない。
 */
export async function loadECharts(): Promise<typeof import('echarts/core')> {
  // 未ロードの場合のみ、実際のロード処理を開始してPromiseをキャッシュする。
  // 呼び出しが重なっても同じPromiseを共有するため、ロード処理は一度しか走らない。
  if (!modulePromise) {
    modulePromise = (async () => {
      // core本体、チャート種別、コンポーネント、レンダラーの4モジュールを並行ロード。
      // これらは個別のrollupチャンクとして分割され、必要になるまでネットワーク
      // 取得されない。
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
      ]);
      // 使用する機能だけをecharts本体に登録する（ツリーシェイキングを効かせるため
      // 全部入りのechartsパッケージではなく、必要なモジュールのみをuse()で有効化）。
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

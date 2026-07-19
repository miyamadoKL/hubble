/**
 * ChartView.tsx
 *
 * クエリ結果を ECharts で描画するチャートコンポーネント。ECharts 本体は初回描画時に
 * 動的インポート（自身のチャンク）で遅延読み込みし、読み込みが終わるまではスピナーを表示する。
 * rows / columns / config（チャート設定）やアプリの配色テーマが変わるたびに、
 * ECharts の option（描画オプション）を作り直して setOption する。また、
 * ホスト要素のリサイズを ResizeObserver で監視し、チャートの再描画（resize）にも対応する。
 * 生の色コードは一切使わず、必ず readChartTheme() 経由で tokens.css のトークン値を参照する。
 */
import { useEffect, useRef, useState } from 'react';
import type { QueryColumn } from '@hubble/contracts';
import type { EChartsType } from 'echarts/core';
import { loadECharts } from '../../chart/echartsLoader';
import { buildChartOption, readChartTheme, type ChartConfig } from '../../chart';
import type { ResultRow } from '../../execution';
import { useUiStore } from '../../stores/uiStore';
import { Spinner } from '../common/Spinner';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';

/**
 * The ECharts canvas for a result chart. ECharts is loaded lazily
 * (own chunk) on first render. The option is rebuilt from rows + config + the
 * current token theme on any change, and the chart re-themes + resizes when the
 * app theme switches or the container resizes. No raw colors — every color comes
 * from `readChartTheme` (tokens.css).
 */
/**
 * クエリ結果（columns / rows）と描画設定（config）を受け取り、ECharts のキャンバスを表示する。
 *
 * @param columns - 結果セットのカラムメタ情報（軸やシリーズの割り当てに使われる）。
 * @param rows - 描画対象の結果行。
 * @param config - チャート種別、軸/シリーズのマッピングなどの描画設定。
 * @param height - チャート描画領域の高さ（px）。デフォルトは 320。fill 指定時は無視される。
 * @param fill - true の場合、固定高さではなく親要素の高さいっぱいに描画する
 *   (ダッシュボード widget などリサイズ可能なコンテナ向け)。
 */
export function ChartView({
  columns,
  rows,
  rowsVersion,
  config,
  height = 320,
  fill = false,
}: {
  columns: QueryColumn[];
  rows: ReadonlyArray<ResultRow>;
  rowsVersion?: number;
  config: ChartConfig;
  height?: number;
  fill?: boolean;
}) {
  const t = useT(commonMessages);
  // ECharts のキャンバスをマウントする DOM 要素への参照。
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 初期化済みの ECharts インスタンスへの参照（アンマウント時に dispose するために保持）。
  const chartRef = useRef<EChartsType | null>(null);
  // ECharts の読み込みと初期化が完了したかどうか（完了するまではローディング表示）。
  const [ready, setReady] = useState(false);
  // アプリ全体の配色テーマ（light/dark 等）。切り替わったらチャートも再テーマする。
  const theme = useUiStore((s) => s.theme);

  // Create the chart instance once (after echarts loads), dispose on unmount.
  // マウント時に一度だけ ECharts をロードしてインスタンスを生成し、
  // アンマウント時に破棄する（依存配列が空なので初回のみ実行）。
  useEffect(() => {
    // 非同期処理完了前にアンマウントされた場合に後続処理をスキップするためのフラグ。
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    // ECharts 本体を動的インポートし、読み込み完了後にキャンバス要素へ init する。
    void loadECharts().then((echarts) => {
      if (disposed || !hostRef.current) return;
      const chart = echarts.init(hostRef.current, undefined, { renderer: 'canvas' });
      chartRef.current = chart;
      setReady(true);
      // ホスト要素のサイズ変更を監視し、変化のたびに chart.resize() を呼んで追従させる。
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => chart.resize());
        resizeObserver.observe(hostRef.current);
      }
    });
    // クリーンアップ: フラグを立てて非同期コールバックの後続処理を止め、
    // ResizeObserver の監視解除と ECharts インスタンスの破棄を行う。
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  // Rebuild + apply the option whenever the inputs or theme change. Reading the
  // theme here (not at mount) makes the chart follow the light/dark switch.
  // columns/rows/config/theme のいずれかが変わるたびに ECharts の option を作り直して適用する。
  // theme をここで読むことで、マウント時点の固定値ではなく、light/dark 切り替えにも追従する。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // 現在の行、カラム、設定、テーマから ECharts option を構築する（該当データがなければ undefined）。
    const option = buildChartOption({ columns, rows, config, theme: readChartTheme() });
    if (option) {
      // `notMerge` so dropping a series / switching type fully replaces the option.
      // notMerge: true を指定し、シリーズ削除やチャート種別変更時に古い option が
      // 部分的に残らないよう、常に option 全体を置き換える。
      chart.setOption(option, { notMerge: true });
    } else {
      // 描画すべきデータ/設定がない場合はキャンバスをクリアする。
      chart.clear();
    }
  }, [columns, rows, rowsVersion, config, theme, ready]);

  return (
    <div
      className={fill ? 'relative h-full bg-surface-sunken' : 'relative bg-surface-sunken'}
      data-testid="chart-canvas"
    >
      {/* ECharts の読み込みと初期化が完了するまでの間だけ表示するローディングオーバーレイ。 */}
      {!ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 font-mono text-2xs text-ink-subtle">
          <Spinner size={14} /> {t('loadingChart')}
        </div>
      )}
      {/* ECharts が init() でキャンバスを描画する対象の DOM 要素。 */}
      <div
        ref={hostRef}
        style={fill ? undefined : { height }}
        className={fill ? 'h-full w-full' : 'w-full'}
      />
    </div>
  );
}

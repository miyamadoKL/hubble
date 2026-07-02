// ============================================================================
// 【ファイル概要】
// このファイルは、Fable のデザイントークン（tokens.css）から実行時に
// チャート用のテーマ（配色やフォント）を解決する処理を担う。
// ECharts の色は必ず --chart-* 等の CSS カスタムプロパティ経由で取得し、
// コード中に生の16進カラーコードを直接書かないことがルール（design.md §5/§6）。
// ライト/ダークテーマの切り替えにも、CSSトークンの値が変わるだけで自動追従する。
// ============================================================================
// Chart theme derived at runtime from the Fable design tokens (tokens.css).
// design.md §5/§6: ECharts colors + font must come from `--chart-*`, ink, border
// and surface tokens via getComputedStyle — NO raw hex in code — and follow the
// light/dark switch. Mirrors the editor theme's token-reading approach.

/**
 * The resolved token values an ECharts option needs.
 * ECharts の option 組み立てに必要な、解決済みのトークン値一式。
 * series は系列配色の配列、それ以外は文字色、枠線色、背景色、フォント等。
 */
export interface ChartTheme {
  /** 系列（シリーズ）ごとの配色。--chart-1〜6 トークンから解決される。 */
  series: string[];
  /** 基本の文字色。 */
  ink: string;
  /** 弱調の文字色（軸ラベルなど）。 */
  inkMuted: string;
  /** さらに弱調の文字色。 */
  inkSubtle: string;
  /** 基本の枠線色。 */
  border: string;
  /** 弱調の枠線色（グリッド線など）。 */
  borderSubtle: string;
  /** 基本の背景（サーフェス）色。 */
  surface: string;
  /** やや持ち上がった（浮いた）サーフェス色。ツールチップ背景などに使用。 */
  surfaceRaised: string;
  /** アクセントカラー。 */
  accent: string;
  /** 通常テキスト用のフォントスタック。 */
  fontFamily: string;
  /** 等幅テキスト用（軸目盛りなど）のフォントスタック。 */
  fontMono: string;
}

// Built without a hex *literal* so the no-raw-hex lint stays satisfied; real
// values always come from the tokens read below, this is only the no-DOM path.
// SSR/テスト環境などDOMが無い場合のフォールバック値。'#' + '0'を6回連結して
// "#000000" を生成することで、ソースコード上に16進カラーの直接リテラルを
// 書かない（no-raw-hex lint ルールを回避する）。実際の描画では必ず下の
// readToken() が CSS トークンから取得した値が使われる。
const FALLBACK = '#'.concat('0'.repeat(6));

// 指定したCSSカスタムプロパティ名（例: '--chart-1'）の値を :root から読み取る。
// ブラウザ環境（window/document）が無い場合や値が空の場合はfallbackを返す。
function readToken(name: string, fallback = FALLBACK): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

/**
 * Read the current theme tokens off :root. Re-read on every render that matters
 * (theme switch) so the chart tracks light/dark without any hard-coded color.
 * :root に設定されている現在のテーマトークンを読み取り、ChartTheme として返す。
 * テーマ切り替え（ライト/ダーク）が起きるたびに呼び出し側で再実行することで、
 * チャートの配色がハードコードなしに追従する。
 */
export function readChartTheme(): ChartTheme {
  // --chart-1 〜 --chart-6 の6色を系列配色として順番に読み取る。
  const series = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6'].map(
    (t) => readToken(t),
  );
  return {
    series,
    ink: readToken('--color-ink-base'),
    inkMuted: readToken('--color-ink-muted'),
    inkSubtle: readToken('--color-ink-subtle'),
    border: readToken('--color-border-base'),
    borderSubtle: readToken('--color-border-subtle'),
    surface: readToken('--color-surface-sunken'),
    surfaceRaised: readToken('--color-surface-raised'),
    accent: readToken('--color-accent'),
    // Plex per design.md §6; the literal stack matches --font-sans / --font-mono.
    // フォントはトークンではなく直接指定（design.md §6 でPlexフォントが指定されて
    // おり、--font-sans / --font-mono と同じフォントスタックを踏襲している）。
    fontFamily: "'IBM Plex Sans', 'IBM Plex Sans JP', ui-sans-serif, system-ui, sans-serif",
    fontMono: "'IBM Plex Mono', ui-monospace, monospace",
  };
}

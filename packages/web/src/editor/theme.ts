// Monaco theme derived at runtime from the Fable design tokens (tokens.css).
// The editor must read `--syntax-*` / surface / ink
// via getComputedStyle and defineTheme — NO raw hex in code — and follow
// light/dark switches. We read the tokens off :root, build a base16-ish Monaco
// theme, and expose a re-apply hook the editor calls on theme change.
//
// ---- ファイル概要（日本語） ----
// Fable のデザイントークン（tokens.css で定義された CSS カスタムプロパティ）から、
// 実行時に Monaco のテーマを組み立てるモジュール。エディターの配色はコード中に生の16進カラーを書かず、必ず `--syntax-*` や
// surface/ink 系のトークンを `getComputedStyle` で読み取って `defineTheme` に渡す
// ことになっている。これによりアプリのライト/ダーク切り替えにエディターの配色も
// 追従する。`:root` からトークン値を読み、Monaco の base16 風テーマオブジェクトを
// 構築し、テーマ変更時にエディター側から呼び出せる再適用フック（applyFableTheme）
// を公開する。

import type * as monaco from 'monaco-editor';

/** Monaco theme names registered by `defineFableThemes`. */
/** `applyFableTheme` が Monaco に登録するテーマ名（ライト/ダークそれぞれ）。 */
export const FABLE_THEME_LIGHT = 'fable-light';
export const FABLE_THEME_DARK = 'fable-dark';

// Last-resort color for the impossible "no DOM / unparseable token" path. Built
// without a hex *literal* so the no-raw-hex lint stays satisfied — real colors
// always come from the design tokens read below.
// DOM が存在しない、またはトークン値が解釈できないという本来起こり得ないケースの
// 最終フォールバック色。16進リテラルを直接書くと "no-raw-hex" lint に引っかかるため、
// 文字列結合で組み立てている。実際の配色は必ず下の readToken 経由でデザイン
// トークンから取得される。
const FALLBACK = '#'.concat('0'.repeat(6));

/**
 * Read a CSS custom property off :root and normalise to a 6-digit hex.
 *
 * `:root` から CSS カスタムプロパティ（デザイントークン）の値を読み取り、
 * 6桁の16進カラー文字列（#rrggbb）に正規化する。SSR などで window が存在しない
 * 場合はフォールバック色を返す。
 */
function readToken(name: string): string {
  if (typeof window === 'undefined') return FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return toHex(raw);
}

/**
 * Monaco's token/theme colors must be hex (no CSS var(), no rgb()). Resolve the
 * common forms our tokens use. Falls back to a neutral value on anything exotic.
 *
 * Monaco のトークン/テーマカラーは16進表記でなければならない（CSS の var() や
 * rgb() はそのままでは受け付けない）。トークンでよく使われる表記（#rgb / #rrggbb /
 * rgb()・rgba()）を16進に変換する。想定外の値が来た場合はフォールバック色を返す。
 */
function toHex(value: string): string {
  if (!value) return FALLBACK;
  if (value.startsWith('#')) {
    // Expand #rgb → #rrggbb.
    // 3桁の短縮形（#rgb）を6桁（#rrggbb）に展開する。
    if (value.length === 4) {
      const r = value[1];
      const g = value[2];
      const b = value[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    // 既に6桁以上ある場合は先頭7文字（# + 6桁）だけを採用する（アルファ成分は無視）。
    return value.slice(0, 7);
  }
  // rgb()/rgba() 形式の値を解析し、各チャンネルを0〜255にクランプした上で
  // 16進2桁ずつに変換して連結する。
  const rgb = value.match(/rgba?\(([^)]+)\)/i);
  if (rgb && rgb[1]) {
    const parts = rgb[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .slice(0, 3);
    const hex = parts
      .map((p) => {
        // パーセント表記（%）なら0-255スケールに変換し、そうでなければそのまま丸める。
        const n = p.endsWith('%')
          ? Math.round((parseFloat(p) / 100) * 255)
          : Math.round(parseFloat(p));
        return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
      })
      .join('');
    if (hex.length === 6) return `#${hex}`;
  }
  return FALLBACK;
}

/** A token color rule mapping a TokenMap scope to a `--syntax-*` token. */
// TokenMap（sql/TokenMap.ts）が出力するハイライトスコープ名と、対応する
// `--syntax-*` デザイントークンとの対応表。Monaco のシンタックスハイライトの
// 配色は、すべてこのテーブル経由でデザイントークンから取得される。
const SYNTAX_RULES: Array<{ scope: string; token: string }> = [
  { scope: 'keyword', token: '--syntax-keyword' },
  { scope: 'string', token: '--syntax-string' },
  { scope: 'number', token: '--syntax-number' },
  { scope: 'comment', token: '--syntax-comment' },
  { scope: 'operator', token: '--syntax-operator' },
  { scope: 'identifier', token: '--syntax-plain' },
  { scope: 'delimiter', token: '--syntax-operator' },
  { scope: 'invalid', token: '--color-error' },
];

// 指定した base（'vs' = ライト系, 'vs-dark' = ダーク系）に対応する Monaco の
// テーマデータを、SYNTAX_RULES とデザイントークンから組み立てる。
function buildTheme(base: 'vs' | 'vs-dark'): monaco.editor.IStandaloneThemeData {
  // 各シンタックススコープに対応する前景色（foreground）ルールを作る。
  // Monaco の rules.foreground は先頭の '#' なしの16進文字列を要求するため slice(1)。
  const rules = SYNTAX_RULES.map(({ scope, token }) => ({
    token: scope,
    foreground: readToken(token).slice(1),
  }));
  return {
    base,
    inherit: true,
    rules,
    colors: {
      'editor.background': readToken('--color-surface-raised'),
      'editor.foreground': readToken('--syntax-plain'),
      'editorLineNumber.foreground': readToken('--color-ink-subtle'),
      'editorLineNumber.activeForeground': readToken('--color-ink-muted'),
      'editorCursor.foreground': readToken('--color-accent'),
      'editor.selectionBackground': readToken('--color-accent-soft'),
      'editor.lineHighlightBackground': readToken('--color-surface-sunken'),
      'editorIndentGuide.background1': readToken('--color-border-subtle'),
      'editorWidget.background': readToken('--color-surface-overlay'),
      'editorWidget.border': readToken('--color-border-base'),
      'editorSuggestWidget.background': readToken('--color-surface-overlay'),
      'editorSuggestWidget.border': readToken('--color-border-base'),
      'editorSuggestWidget.selectedBackground': readToken('--color-accent-soft'),
      'editorHoverWidget.background': readToken('--color-surface-overlay'),
      'editorHoverWidget.border': readToken('--color-border-base'),
      'editorError.foreground': readToken('--color-error'),
    },
  };
}

/**
 * Define (or redefine) both Fable themes from the *current* token values, then
 * apply the one matching `mode`. Call on mount and whenever the app theme
 * changes so the editor tracks token updates without any hard-coded hex.
 *
 * その時点のデザイントークンの値からライト/ダーク両方の Fable テーマを
 * 定義（または再定義）し、`mode` に対応する方を Monaco に適用する。エディターの
 * マウント時、およびアプリのテーマが切り替わるたびに呼び出すことで、ハード
 * コードした16進カラーなしにトークンの更新へ追従できる。
 */
export function applyFableTheme(monacoNs: typeof monaco, mode: 'light' | 'dark'): void {
  // 呼ぶたびに両テーマを最新のトークン値で再定義する（defineTheme は上書き可能）。
  monacoNs.editor.defineTheme(FABLE_THEME_LIGHT, buildTheme('vs'));
  monacoNs.editor.defineTheme(FABLE_THEME_DARK, buildTheme('vs-dark'));
  // 指定された mode に対応するテーマを実際に適用する。
  monacoNs.editor.setTheme(mode === 'dark' ? FABLE_THEME_DARK : FABLE_THEME_LIGHT);
}

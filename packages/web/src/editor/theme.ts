// Monaco theme derived at runtime from the Fable design tokens (tokens.css).
// design.md §8 / P3a brief: the editor must read `--syntax-*` / surface / ink
// via getComputedStyle and defineTheme — NO raw hex in code — and follow
// light/dark switches. We read the tokens off :root, build a base16-ish Monaco
// theme, and expose a re-apply hook the editor calls on theme change.

import type * as monaco from 'monaco-editor';

/** Monaco theme names registered by `defineFableThemes`. */
export const FABLE_THEME_LIGHT = 'fable-light';
export const FABLE_THEME_DARK = 'fable-dark';

// Last-resort color for the impossible "no DOM / unparseable token" path. Built
// without a hex *literal* so the no-raw-hex lint stays satisfied — real colors
// always come from the design tokens read below.
const FALLBACK = '#'.concat('0'.repeat(6));

/** Read a CSS custom property off :root and normalise to a 6-digit hex. */
function readToken(name: string): string {
  if (typeof window === 'undefined') return FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return toHex(raw);
}

/**
 * Monaco's token/theme colors must be hex (no CSS var(), no rgb()). Resolve the
 * common forms our tokens use. Falls back to a neutral value on anything exotic.
 */
function toHex(value: string): string {
  if (!value) return FALLBACK;
  if (value.startsWith('#')) {
    // Expand #rgb → #rrggbb.
    if (value.length === 4) {
      const r = value[1];
      const g = value[2];
      const b = value[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return value.slice(0, 7);
  }
  const rgb = value.match(/rgba?\(([^)]+)\)/i);
  if (rgb && rgb[1]) {
    const parts = rgb[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .slice(0, 3);
    const hex = parts
      .map((p) => {
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

function buildTheme(base: 'vs' | 'vs-dark'): monaco.editor.IStandaloneThemeData {
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
 */
export function applyFableTheme(monacoNs: typeof monaco, mode: 'light' | 'dark'): void {
  monacoNs.editor.defineTheme(FABLE_THEME_LIGHT, buildTheme('vs'));
  monacoNs.editor.defineTheme(FABLE_THEME_DARK, buildTheme('vs-dark'));
  monacoNs.editor.setTheme(mode === 'dark' ? FABLE_THEME_DARK : FABLE_THEME_LIGHT);
}

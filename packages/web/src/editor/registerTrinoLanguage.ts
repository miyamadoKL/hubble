// One-shot registration of the Trino SQL language for Monaco (design.md §8:
// "registerTrinoLanguage(monaco, deps) で一括登録"). Splits the old 950-line
// QueryEditorPane monolith into discrete, independently testable concerns:
//
//   - tokenizer        : ANTLR lexer + TokenMap (line-stateless)
//   - completion       : phantom-cursor + antlr4-c3 (analyzer.collectCompletions)
//   - hover            : table schema from the injected SchemaCache
//   - markers + decos  : 200ms-debounced parse with a generation counter
//
// Registration is idempotent per Monaco namespace (multiple editors share it).
// The marker/decoration loop is attached *per editor* via `attachDiagnostics`.

import type * as monaco from 'monaco-editor';
import { CharStream } from 'antlr4ng';
import { SqlBaseLexer } from '../trino-lang/generated/SqlBaseLexer.js';
import {
  collectCompletions,
  parseStatement,
  tokenMap,
  TableReference,
  type CompletionCandidate,
} from '../trino-lang';
import type { SchemaCache } from '../trino-lang';
import { applyFableTheme } from './theme';
import { formatEditor } from './formatter';

export const TRINO_LANGUAGE_ID = 'trino-sql';

const PARSE_DEBOUNCE_MS = 200;
const MARKER_OWNER = 'trino-sql';

/** Dependencies injected into the language layer (no globals). */
export interface TrinoLanguageDeps {
  /** Synchronous-read schema cache backed by the DI'd MetadataSource. */
  cache: SchemaCache;
  /** Current catalog.schema context for relative name resolution. */
  getContext: () => { catalog?: string; schema?: string };
  /** Current app theme, so the editor theme can track it. */
  getTheme?: () => 'light' | 'dark';
  /** Invoked when the user presses Ctrl/Cmd+Enter. */
  onExecute?: (editor: monaco.editor.ICodeEditor) => void;
}

let registered = false;

/**
 * Register the Trino language, its tokenizer, completion + hover providers and
 * the editor theme. Safe to call repeatedly; only the first call per namespace
 * does the work. The returned deps reference is captured by the providers, so
 * callers should keep `getContext` reading live state.
 */
export function registerTrinoLanguage(monacoNs: typeof monaco, deps: TrinoLanguageDeps): void {
  // Always (re)apply the theme so token changes propagate even if the language
  // was already registered.
  applyFableTheme(monacoNs, deps.getTheme?.() ?? 'light');

  if (registered) return;
  registered = true;

  monacoNs.languages.register({ id: TRINO_LANGUAGE_ID, aliases: ['Trino SQL', 'trinosql'] });
  monacoNs.languages.setLanguageConfiguration(TRINO_LANGUAGE_ID, {
    comments: { lineComment: '--', blockComment: ['/*', '*/'] },
    brackets: [
      ['(', ')'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
    ],
  });

  registerTokenizer(monacoNs);
  registerCompletionProvider(monacoNs, deps);
  registerHoverProvider(monacoNs, deps);
}

/** Per-line ANTLR tokenizer mapping token types → TokenMap highlight scopes. */
function registerTokenizer(monacoNs: typeof monaco): void {
  // The tokenizer is line-stateless, but Monaco's IState contract still needs a
  // real `clone()` + `equals()` (a bare object throws "endState.equals is not a
  // function" and silently kills the whole language). One shared instance is
  // fine since there is no per-line carry-over.
  const STATE: monaco.languages.IState = {
    clone: () => STATE,
    equals: () => true,
  };
  monacoNs.languages.setTokensProvider(TRINO_LANGUAGE_ID, {
    getInitialState: () => STATE,
    tokenize: (line) => {
      const lexer = new SqlBaseLexer(CharStream.fromString(line));
      lexer.removeErrorListeners();
      const tokens: monaco.languages.IToken[] = [];
      let token = lexer.nextToken();
      while (token.type !== SqlBaseLexer.EOF) {
        tokens.push({
          startIndex: token.column,
          scopes: tokenMap[token.type as keyof typeof tokenMap] ?? 'identifier',
        });
        token = lexer.nextToken();
      }
      return { tokens, endState: STATE };
    },
  });
}

/** Map an editor-agnostic candidate to a Monaco completion item. */
function toMonacoItem(
  monacoNs: typeof monaco,
  candidate: CompletionCandidate,
  range: monaco.IRange,
): monaco.languages.CompletionItem {
  const kindMap: Record<CompletionCandidate['kind'], monaco.languages.CompletionItemKind> = {
    keyword: monacoNs.languages.CompletionItemKind.Keyword,
    snippet: monacoNs.languages.CompletionItemKind.Snippet,
    table: monacoNs.languages.CompletionItemKind.Struct,
    cte: monacoNs.languages.CompletionItemKind.Reference,
    column: monacoNs.languages.CompletionItemKind.Field,
    columnList: monacoNs.languages.CompletionItemKind.Field,
  };
  // Lower sortPriority sorts later; invert into a zero-padded sortText so higher
  // priority (schema items) appears first.
  const priority = candidate.sortPriority ?? 1;
  const sortText = String(1000 - priority).padStart(4, '0') + candidate.label;
  return {
    label: candidate.label,
    kind: kindMap[candidate.kind],
    detail: candidate.detail,
    insertText: candidate.insertText,
    insertTextRules: candidate.isSnippet
      ? monacoNs.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : monacoNs.languages.CompletionItemInsertTextRule.None,
    sortText,
    range,
  };
}

function registerCompletionProvider(monacoNs: typeof monaco, deps: TrinoLanguageDeps): void {
  monacoNs.languages.registerCompletionItemProvider(TRINO_LANGUAGE_ID, {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const sql = model.getValue();
      const offset = model.getOffsetAt(position);
      const { catalog, schema } = deps.getContext();
      const candidates = collectCompletions({
        sql,
        offset,
        cache: deps.cache,
        catalog,
        schema,
      });

      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: candidates.map((c) => toMonacoItem(monacoNs, c, range)),
      };
    },
  });
}

function registerHoverProvider(monacoNs: typeof monaco, deps: TrinoLanguageDeps): void {
  monacoNs.languages.registerHoverProvider(TRINO_LANGUAGE_ID, {
    provideHover: async (model, position) => {
      const { catalog, schema } = deps.getContext();
      const { descriptors } = parseStatement(model.getValue(), catalog, schema);
      const hit = descriptors.find((d) => {
        const r = d.range;
        return (
          position.lineNumber >= r.startLineNumber &&
          position.lineNumber <= r.endLineNumber &&
          position.column >= r.startColumn &&
          position.column <= r.endColumn
        );
      });
      if (!hit?.tableReference) return null;
      const table = await deps.cache.resolveTable(hit.tableReference);
      if (!table) return null;
      const cols = table.getColumns();
      const header = `**${hit.tableReference.fullyQualified}**`;
      const body = cols.map((c) => `- \`${c.getName()}\` ${c.getType()}`).join('\n');
      return {
        range: new monacoNs.Range(
          hit.range.startLineNumber,
          hit.range.startColumn,
          hit.range.endLineNumber,
          hit.range.endColumn,
        ),
        contents: [{ value: `${header}\n\n${body}` }],
      };
    },
  });
}

/**
 * Attach the debounced parse → marker/decoration loop to one editor. Returns a
 * disposer. Uses a generation counter so a late parse never clobbers a newer
 * one (design.md §8 stale-result guard). Also wires Ctrl/Cmd+Enter execute and
 * the format action (Ctrl/Cmd+I).
 */
export function attachDiagnostics(
  monacoNs: typeof monaco,
  editor: monaco.editor.IStandaloneCodeEditor,
  deps: TrinoLanguageDeps,
): monaco.IDisposable {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decorations = editor.createDecorationsCollection([]);

  const run = () => {
    const model = editor.getModel();
    if (!model) return;
    const gen = ++generation;
    const { catalog, schema } = deps.getContext();
    const { markers, descriptors, tableReferences } = parseStatement(
      model.getValue(),
      catalog,
      schema,
    );
    // Drop stale results.
    if (gen !== generation) return;

    monacoNs.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      markers.map((m) => ({
        severity: monacoNs.MarkerSeverity.Error,
        message: m.message,
        startLineNumber: m.startLineNumber,
        startColumn: m.startColumn,
        endLineNumber: m.endLineNumber,
        endColumn: m.endColumn,
      })),
    );

    decorations.set(
      descriptors.map((d) => ({
        range: new monacoNs.Range(
          d.range.startLineNumber,
          d.range.startColumn,
          d.range.endLineNumber,
          d.range.endColumn,
        ),
        options: { inlineClassName: `trino-${d.inlineClassName}` },
      })),
    );

    // Warm metadata for referenced tables so the next hover/completion is ready.
    for (const ref of tableReferences) deps.cache.warmTable(ref);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, PARSE_DEBOUNCE_MS);
  };

  const changeSub = editor.onDidChangeModelContent(schedule);

  editor.addCommand(monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.Enter, () => {
    deps.onExecute?.(editor);
  });
  editor.addAction({
    id: 'fable.formatSql',
    label: 'Format SQL (Trino)',
    // Ctrl/Cmd+I and Ctrl/Cmd+Shift+F both format (design.md §5).
    keybindings: [
      monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyI,
      monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.KeyF,
    ],
    contextMenuGroupId: 'modification',
    contextMenuOrder: 1.5,
    run: (ed) => formatEditor(ed),
  });

  // Initial pass.
  run();

  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      changeSub.dispose();
      decorations.clear();
      const model = editor.getModel();
      if (model) monacoNs.editor.setModelMarkers(model, MARKER_OWNER, []);
    },
  };
}

export { TableReference };

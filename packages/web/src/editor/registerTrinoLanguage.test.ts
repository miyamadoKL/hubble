/** Monaco provider が再登録後の依存を参照することを検証する。 */
import { describe, expect, test, vi } from 'vitest';
import type * as monaco from 'monaco-editor';
import { SchemaCache } from '../trino-lang';
import TableReference from '../trino-lang/schema/TableReference';
import type { MetadataSource } from '../trino-lang/sql/MetadataSource';
import { registerTrinoLanguage, type TrinoLanguageDeps } from './registerTrinoLanguage';

function metadataSource(catalog: string, schema: string, column: string): MetadataSource {
  return {
    listCatalogs: async () => [catalog],
    listSchemas: async () => [schema],
    listTables: async () => ['orders'],
    getTable: async () => ({
      catalog,
      schema,
      name: 'orders',
      columns: [{ name: column, type: 'bigint' }],
    }),
  };
}

async function deps(catalog: string, schema: string, column: string): Promise<TrinoLanguageDeps> {
  const cache = new SchemaCache(metadataSource(catalog, schema, column));
  await cache.resolveTable(new TableReference(catalog, schema, 'orders'));
  return { cache, getContext: () => ({ catalog, schema }) };
}

function monacoNamespace(): {
  namespace: typeof monaco;
  completion: () => monaco.languages.CompletionItemProvider;
  hover: () => monaco.languages.HoverProvider;
} {
  let completionProvider: monaco.languages.CompletionItemProvider | undefined;
  let hoverProvider: monaco.languages.HoverProvider | undefined;
  class Range {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number,
    ) {}
  }
  const namespace = {
    Range,
    languages: {
      CompletionItemKind: {
        Keyword: 1,
        Snippet: 2,
        Struct: 3,
        Reference: 4,
        Field: 5,
      },
      CompletionItemInsertTextRule: { None: 0, InsertAsSnippet: 4 },
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setTokensProvider: vi.fn(),
      registerCompletionItemProvider: vi.fn(
        (_id: string, provider: monaco.languages.CompletionItemProvider) => {
          completionProvider = provider;
          return { dispose: vi.fn() };
        },
      ),
      registerHoverProvider: vi.fn((_id: string, provider: monaco.languages.HoverProvider) => {
        hoverProvider = provider;
        return { dispose: vi.fn() };
      }),
    },
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
    },
  } as unknown as typeof monaco;
  return {
    namespace,
    completion: () => {
      if (!completionProvider) throw new Error('completion provider was not registered');
      return completionProvider;
    },
    hover: () => {
      if (!hoverProvider) throw new Error('hover provider was not registered');
      return hoverProvider;
    },
  };
}

describe('registerTrinoLanguage', () => {
  test('再登録後のcontextとcacheをcompletionとhoverに使う', async () => {
    const mock = monacoNamespace();
    const first = await deps('old_catalog', 'old_schema', 'old_column');
    const second = await deps('new_catalog', 'new_schema', 'new_column');
    registerTrinoLanguage(mock.namespace, first);
    registerTrinoLanguage(mock.namespace, second);
    expect(mock.namespace.languages.registerCompletionItemProvider).toHaveBeenCalledOnce();
    expect(mock.namespace.languages.registerHoverProvider).toHaveBeenCalledOnce();

    const completionSql = 'SELECT  FROM orders';
    const completion = await mock.completion().provideCompletionItems(
      {
        getValue: () => completionSql,
        getOffsetAt: () => 'SELECT '.length,
        getWordUntilPosition: () => ({ word: '', startColumn: 8, endColumn: 8 }),
      } as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 8 } as monaco.Position,
      {} as monaco.languages.CompletionContext,
      { isCancellationRequested: false } as monaco.CancellationToken,
    );
    const completionLabels = completion?.suggestions.map((item) => String(item.label)) ?? [];
    expect(completionLabels).toContain('new_column');
    expect(completionLabels).not.toContain('old_column');

    const hoverSql = 'SELECT * FROM orders';
    const hover = await mock
      .hover()
      .provideHover(
        { getValue: () => hoverSql } as unknown as monaco.editor.ITextModel,
        { lineNumber: 1, column: 16 } as monaco.Position,
        { isCancellationRequested: false } as monaco.CancellationToken,
      );
    const hoverText = hover?.contents.map((content) => content.value).join('\n') ?? '';
    expect(hoverText).toContain('new_catalog.new_schema.orders');
    expect(hoverText).toContain('new_column');
    expect(hoverText).not.toContain('old_column');
  });
});

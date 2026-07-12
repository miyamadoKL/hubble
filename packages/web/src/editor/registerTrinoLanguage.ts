// One-shot registration of the Trino SQL language for Monaco (
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
//
// ---- ファイル概要（日本語） ----
// Monaco エディターに Trino SQL 言語を登録するモジュール。旧 950 行の
// QueryEditorPane モノリスを、以下の独立してテスト可能な関心事に分割している。
//   - tokenizer       : ANTLR レキサーのトークンを TokenMap でハイライト用スコープへ変換（行状態を持たない）
//   - completion      : ファントムカーソル方式 + antlr4-c3 による補完候補の収集
//   - hover           : 注入された SchemaCache からテーブルのスキーマ情報を引いてホバー表示
//   - markers + decos : 200ms デバウンスした構文解析結果をエラーマーカー/装飾へ反映（世代カウンタで古い結果を破棄）
// 言語登録自体は Monaco の名前空間単位で冪等（複数エディターインスタンスが共有しても re-register されない）。
// マーカー/装飾の更新ループはエディターごとに `attachDiagnostics` で個別にアタッチする。

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
import { startDiagnostics, type DiagnosticsTask } from '../trino-lang/diagnosticsWorkerClient';
import { applyFableTheme } from './theme';

/** Monaco に登録する Trino SQL 言語の ID（言語登録や補完/ホバープロバイダーの紐付けに使う）。 */
export const TRINO_LANGUAGE_ID = 'trino-sql';

// 構文解析のデバウンス時間（ms）。入力のたびに毎回パースしないよう間引く。
const PARSE_DEBOUNCE_MS = 200;
// setModelMarkers の owner 文字列。実行時エラー用マーカー（EXEC_MARKER_OWNER）とは別 owner にして共存させる。
export const TRINO_MARKER_OWNER = 'trino-sql';
const MARKER_OWNER = TRINO_MARKER_OWNER;

/** Dependencies injected into the language layer (no globals). */
/** 言語レイヤーに注入する依存関係（グローバル状態を持たせないための DI）。 */
export interface TrinoLanguageDeps {
  /** Synchronous-read schema cache backed by the DI'd MetadataSource. */
  /** 同期読み取り可能なスキーマキャッシュ（DI された MetadataSource の上に構築される）。 */
  cache: SchemaCache;
  /** Current catalog.schema context for relative name resolution. */
  /** 相対テーブル名解決に使う、現在の catalog.schema コンテキスト。 */
  getContext: () => { catalog?: string; schema?: string };
  /** Current app theme, so the editor theme can track it. */
  /** 現在のアプリテーマ（エディターのテーマを追従させるために使う）。 */
  getTheme?: () => 'light' | 'dark';
  /** Invoked when the user presses Ctrl/Cmd+Enter. */
  /** ユーザーが Ctrl/Cmd+Enter を押したときに呼ばれる実行ハンドラ。 */
  onExecute?: (editor: monaco.editor.ICodeEditor) => void;
}

interface TrinoLanguageRegistration {
  deps: TrinoLanguageDeps;
}

/** Monaco 名前空間ごとに登録済み provider が読む最新依存を保持する。 */
const registrations = new WeakMap<typeof monaco, TrinoLanguageRegistration>();

/**
 * Register the Trino language, its tokenizer, completion + hover providers and
 * the editor theme. Safe to call repeatedly; only the first call per namespace
 * does the work.
 *
 * Monaco へ Trino 言語本体、tokenizer、補完/ホバープロバイダー、エディターテーマを登録する。
 * 何度呼んでも安全で、名前空間ごとに最初の 1 回だけ provider を登録する。
 * 2 回目以降は provider が読む依存を差し替え、再 mount 後の cache と context を反映する。
 */
export function registerTrinoLanguage(monacoNs: typeof monaco, deps: TrinoLanguageDeps): void {
  // Always (re)apply the theme so token changes propagate even if the language
  // was already registered.
  // 言語が登録済みでもテーマは毎回再適用する（デザイントークンの変更を反映させるため）。
  applyFableTheme(monacoNs, deps.getTheme?.() ?? 'light');

  const existing = registrations.get(monacoNs);
  if (existing) {
    existing.deps = deps;
    return;
  }
  const registration: TrinoLanguageRegistration = { deps };
  registrations.set(monacoNs, registration);

  // 言語 ID とエイリアスを登録。
  monacoNs.languages.register({ id: TRINO_LANGUAGE_ID, aliases: ['Trino SQL', 'trinosql'] });
  // コメント記法、括弧、自動閉じ括弧など、エディターの基本的な言語挙動を設定する。
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

  // tokenizer / 補完プロバイダー / ホバープロバイダーをそれぞれ独立した関数で登録する。
  registerTokenizer(monacoNs);
  registerCompletionProvider(monacoNs, () => registration.deps);
  registerHoverProvider(monacoNs, () => registration.deps);
}

/** Per-line ANTLR tokenizer mapping token types → TokenMap highlight scopes. */
/** 1 行単位で ANTLR レキサーを走らせ、トークン種別を TokenMap のハイライトスコープへ変換する tokenizer。 */
function registerTokenizer(monacoNs: typeof monaco): void {
  // The tokenizer is line-stateless, but Monaco's IState contract still needs a
  // real `clone()` + `equals()` (a bare object throws "endState.equals is not a
  // function" and silently kills the whole language). One shared instance is
  // fine since there is no per-line carry-over.
  const STATE: monaco.languages.IState = {
    clone: () => STATE,
    equals: () => true,
  };
  // 行ごとに ANTLR レキサーを新規生成してトークン化する。エラーリスナーは外し、
  // 不正なトークンでも例外を投げずにハイライトを継続させる。
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
/** trino-lang 側のエディター非依存な補完候補を、Monaco の CompletionItem 形式へ変換する。 */
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
  // sortPriority が低いほど後ろに並ぶ仕様なので、優先度を反転させ 0 埋め文字列の
  // sortText に変換する（優先度の高いスキーマ候補が先頭に来るようにするため）。
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

// 補完プロバイダー本体を登録する。'.'（テーブル修飾後のカラム展開）と ' '
// （キーワード直後の候補表示）をトリガー文字とする。
function registerCompletionProvider(
  monacoNs: typeof monaco,
  getDeps: () => TrinoLanguageDeps,
): void {
  monacoNs.languages.registerCompletionItemProvider(TRINO_LANGUAGE_ID, {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const deps = getDeps();
      const sql = model.getValue();
      const offset = model.getOffsetAt(position);
      const { catalog, schema } = deps.getContext();
      // trino-lang の collectCompletions にソース全文とカーソルオフセットを渡し、
      // ファントムカーソル方式 + antlr4-c3 で候補を収集する。
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

// ホバープロバイダーを登録する。カーソル位置がテーブル参照の範囲に重なっていれば、
// スキーマキャッシュから解決したカラム一覧を Markdown で表示する。
function registerHoverProvider(monacoNs: typeof monaco, getDeps: () => TrinoLanguageDeps): void {
  monacoNs.languages.registerHoverProvider(TRINO_LANGUAGE_ID, {
    provideHover: async (model, position) => {
      const deps = getDeps();
      const { catalog, schema } = deps.getContext();
      const { descriptors } = parseStatement(model.getValue(), catalog, schema);
      // ステートメント記述子（テーブル参照の位置情報など）の中から、
      // カーソル位置を含むものを探す。
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
      // 非同期にスキーマを解決する（未取得ならメタデータ API を叩く）。
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
 * one (stale-result guard). Also wires Ctrl/Cmd+Enter execute and
 * the format action (Ctrl/Cmd+I).
 *
 * 1 つのエディターに「デバウンスした構文解析 → マーカー/装飾更新」ループをアタッチする。
 * 返り値の disposer を呼ぶとループとリソースを解放する。世代カウンタ（generation）を使い、
 * 遅れて完了した古い解析結果が新しい結果を上書きしないようにする（stale-result
 * 対策）。あわせて Ctrl/Cmd+Enter での実行、Ctrl/Cmd+I 等での整形アクションも
 * このエディターに配線する。
 */
export function attachDiagnostics(
  monacoNs: typeof monaco,
  editor: monaco.editor.IStandaloneCodeEditor,
  deps: TrinoLanguageDeps,
): monaco.IDisposable {
  // 世代カウンタ。run() が呼ばれるたびにインクリメントし、非同期処理完了時に
  // 最新世代かどうかを確認して古い結果を捨てる。
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let task: DiagnosticsTask | undefined;
  const decorations = editor.createDecorationsCollection([]);

  // 構文解析を実行し、エラーマーカーとテーブル参照の装飾を更新する本体処理。
  const run = async () => {
    const model = editor.getModel();
    if (!model) return;
    const gen = ++generation;
    const { catalog, schema } = deps.getContext();
    task?.cancel();
    task = startDiagnostics({
      sql: model.getValue(),
      ...(catalog !== undefined ? { catalog } : {}),
      ...(schema !== undefined ? { schema } : {}),
    });
    let result;
    try {
      result = await task.promise;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (gen !== generation) return;
      monacoNs.editor.setModelMarkers(model, MARKER_OWNER, [
        {
          severity: monacoNs.MarkerSeverity.Error,
          message: error instanceof Error ? error.message : 'SQL diagnostics failed',
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
        },
      ]);
      decorations.clear();
      return;
    }
    const { markers, descriptors, tableReferences } = result;
    // Drop stale results.
    // このタイマー発火中にさらに新しい入力があれば generation が進んでいるため、
    // 古い結果は破棄して何もしない。
    if (gen !== generation) return;

    // 構文エラーを Monaco のマーカー（赤波線）として反映する。
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

    // テーブル参照部分に特別なインラインスタイル（trino-${class}）を付与する装飾を更新する。
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
    // SQL 中で参照されているテーブルのメタデータを先読みしておき、次のホバー/補完が
    // 待たされないようにする。
    for (const ref of tableReferences) deps.cache.warmTable(ref);
  };

  // 入力のたびに呼ばれ、直前のタイマーをキャンセルしてから再スケジュールする
  // （PARSE_DEBOUNCE_MS の間、入力が止まったら実際にパースする）。
  const schedule = () => {
    generation += 1;
    task?.cancel();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), PARSE_DEBOUNCE_MS);
  };

  const changeSub = editor.onDidChangeModelContent(schedule);

  // Ctrl/Cmd+Enter: 現在のカーソル/選択範囲に基づく実行コマンドを呼び出し元に委譲する。
  editor.addCommand(monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.Enter, () => {
    deps.onExecute?.(editor);
  });
  // SQL 整形アクションをコマンドパレット/右クリックメニュー/ショートカットに登録する。
  editor.addAction({
    id: 'fable.formatSql',
    label: 'Format SQL (Trino)',
    // Ctrl/Cmd+I and Ctrl/Cmd+Shift+F both format.
    keybindings: [
      monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyI,
      monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.KeyF,
    ],
    contextMenuGroupId: 'modification',
    contextMenuOrder: 1.5,
    run: async (ed) => {
      // 整形操作を選んだ時点でだけ sql-formatter の大きな chunk を取得する。
      const { formatEditor } = await import('./formatter');
      formatEditor(ed);
    },
  });

  // Initial pass.
  // アタッチ直後に一度パースしておき、初期表示からマーカー/装飾が反映された状態にする。
  void run();

  return {
    dispose: () => {
      generation += 1;
      task?.cancel();
      if (timer) clearTimeout(timer);
      changeSub.dispose();
      decorations.clear();
      const model = editor.getModel();
      if (model) monacoNs.editor.setModelMarkers(model, MARKER_OWNER, []);
    },
  };
}

export { TableReference };

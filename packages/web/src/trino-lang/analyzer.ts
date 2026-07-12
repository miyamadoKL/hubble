// `analyzer.ts` is the synchronous, editor-agnostic heart of the language
// support. It exposes pure-ish functions used by the Monaco providers in
// ../editor/ and exercised directly by vitest (no monaco-editor import here):
//
//   parseStatement(sql)            -> markers + decoration descriptors
//   collectCompletions({...})      -> grammar + schema completion candidates
//
// Completion follows the "phantom cursor" approach: insert a sentinel
// identifier at the caret, run antlr4-c3 with preferredRules) and fold in
// schema candidates (table names + CTE names + columns of the in-context
// table) sourced from the synchronous SchemaCache.
//
// ---- ファイル概要（日本語） ----
// `analyzer.ts` は、Trino SQL の言語サポートのうち「同期的かつエディターに
// 依存しない中核処理」を担うモジュール。monaco-editor を一切 import せず、以下の
// 2 つの関数を公開する。
//   - parseStatement(sql)       : ANTLR で SQL をパースし、構文エラーマーカーと
//                                  テーブル名などのハイライト用デコレーション記述子
//                                  を返す。
//   - collectCompletions({...}) : カーソル位置における補完候補（キーワード/スニペット
//                                  /テーブル名/CTE名/カラム名）を収集する。
// これらは ../editor/registerTrinoLanguage.ts の Monaco プロバイダー（tokenizer,
// completion, hover）から呼ばれるほか、vitest から直接（Monaco なしで）テストできる。
//
// 補完（collectCompletions）は「ファントムカーソル方式」を採る: カーソル位置に
// ダミーの識別子（PHANTOM）を挿入した上で再パースし、antlr4-c3 の
// CodeCompletionCore に「このトークン位置で構文上どんなトークン/ルールが
// 続き得るか」を問い合わせる。そこにさらに、同期読み取り可能な SchemaCache から
// 得たスキーマ由来の候補（テーブル名、CTE名、現在の文脈で参照しているテーブルの
// カラム名）を合成して最終的な候補一覧を作る。

import { CodeCompletionCore } from 'antlr4-c3';
import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import { SqlBaseLexer } from './generated/SqlBaseLexer.js';
import { SqlBaseParser } from './generated/SqlBaseParser.js';
import SqlBaseListenerImpl from './sql/SqlBaseListenerImpl';
import SqlBaseErrorListener, { type TrinoSqlMarker } from './sql/SqlBaseErrorListener';
import type { HighlightDescriptor } from './sql/SpecialHighlight';
import type { SchemaCache } from './sql/SchemaCache';
import TableReference from './schema/TableReference';

export type { TrinoSqlMarker } from './sql/SqlBaseErrorListener';
export type { HighlightDescriptor } from './sql/SpecialHighlight';

/** Sentinel identifier inserted at the caret for completion (phantom cursor). */
/** 補完処理でカーソル位置に挿入するダミー識別子（ファントムカーソル）。 */
const PHANTOM = '__fable_caret__';

/**
 * Editor-agnostic completion candidate. The editor maps these to Monaco.
 *
 * エディターに依存しない補完候補。registerTrinoLanguage.ts の toMonacoItem が
 * これを Monaco の CompletionItem 形式に変換する。
 */
export interface CompletionCandidate {
  label: string;
  /** Text inserted on accept (defaults to label). */
  /** 候補を確定したときに実際に挿入されるテキスト（省略時は label と同じ）。 */
  insertText: string;
  kind: 'keyword' | 'snippet' | 'table' | 'cte' | 'column' | 'columnList';
  detail?: string;
  /** Higher sorts first; lets schema items outrank raw keywords. */
  /** 値が大きいほど候補リストの上位に来る（テーブル名/カラム名を素のキーワードより優先表示するため）。 */
  sortPriority?: number;
  /** True when insertText is a Monaco snippet (uses ${} placeholders). */
  /** insertText が Monaco のスニペット構文（${1:...} のようなプレースホルダー）を含む場合に true。 */
  isSnippet?: boolean;
}

/**
 * Result of parsing a single SQL statement.
 *
 * 1 つの SQL ステートメントをパースした結果。
 */
export interface ParseResult {
  markers: TrinoSqlMarker[];
  descriptors: HighlightDescriptor[];
  /** Table references discovered in the statement (for cache warming). */
  /** ステートメント中で見つかったテーブル参照の一覧（SchemaCache のウォーミング用）。 */
  tableReferences: TableReference[];
}

// runParse の戻り値。ParseResult に加えて、呼び出し元（collectCompletions）が
// 再利用するパーサー/トークンストリーム/listener の実体も保持する内部専用の型。
interface ParseInternals extends ParseResult {
  parser: SqlBaseParser;
  tokenStream: CommonTokenStream;
  listener: SqlBaseListenerImpl;
}

// SQL 文字列から ANTLR のレキサー/パーサー/トークンストリームを組み立てる共通処理。
// parseStatement と collectCompletions の両方から呼ばれる。
function buildParser(sql: string): {
  parser: SqlBaseParser;
  tokenStream: CommonTokenStream;
} {
  // 空文字列だと ANTLR の CharStream が困るため、最低でも半角スペース1文字を渡す。
  const input = CharStream.fromString(sql.length ? sql : ' ');
  const lexer = new SqlBaseLexer(input);
  lexer.removeErrorListeners();
  const tokenStream = new CommonTokenStream(lexer);
  const parser = new SqlBaseParser(tokenStream);
  return { parser, tokenStream };
}

// SQL 文字列を実際にパースし、SqlBaseListenerImpl（テーブル名/CTE等の収集）と
// SqlBaseErrorListener（構文エラーの収集）の両方を登録した上で結果をまとめる。
function runParse(sql: string, catalog?: string, schema?: string): ParseInternals {
  const { parser, tokenStream } = buildParser(sql);
  // パースツリー走査用の listener。テーブル名ハイライトや CTE/エイリアス名を集める。
  const listener = new SqlBaseListenerImpl(catalog, schema);
  parser.addParseListener(listener);
  parser.removeErrorListeners();
  // 構文エラーを集めるエラーリスナー（Monaco のマーカーに変換される）。
  const errors = new SqlBaseErrorListener();
  parser.addErrorListener(errors);
  // singleStatement は SqlBase.g4 のトップレベルルール。ここで実際にパースが走る。
  parser.singleStatement();
  tokenStream.fill();

  // listener が集めたステートメントごとのテーブル名から、TableReference の一覧を作る。
  // SchemaCache のウォーミング（事前フェッチ指示）に使われる。
  const tableReferences: TableReference[] = [];
  for (const stmt of listener.statements) {
    tableReferences.push(refFor(stmt.tableName, catalog, schema));
  }

  return {
    parser,
    tokenStream,
    listener,
    markers: errors.getMarkers(),
    descriptors: listener.getDescriptors(),
    tableReferences,
  };
}

/**
 * Build a TableReference, honouring fully-qualified names and context.
 *
 * テーブル名から TableReference を組み立てる。完全修飾名（catalog.schema.table）
 * ならそれをそのまま使い、そうでなければ現在の catalog/schema コンテキストで
 * 補完する。コンテキストも無い場合は名前をそのまま "." 分割してベストエフォートで
 * 組み立てる。
 */
function refFor(name: string, catalog?: string, schema?: string): TableReference {
  if (TableReference.isFullyQualified(name)) return TableReference.fromFullyQualified(name);
  if (catalog && schema) return new TableReference(catalog, schema, name);
  return TableReference.fromFullyQualified(name);
}

/**
 * Parse a single statement for syntax markers + table-name decorations.
 * Never throws — a thrown error becomes a single line-1 marker.
 *
 * 1 つの SQL ステートメントをパースし、構文エラーマーカーとテーブル名の
 * デコレーション記述子を返す。例外を投げることはなく（ANTLR や内部処理が
 * 予期せず例外を投げた場合も）、その場合は 1 行目に単一のエラーマーカーを
 * 生成して返す（エディター側の表示が壊れないようにするため）。
 */
export function parseStatement(sql: string, catalog?: string, schema?: string): ParseResult {
  // 空文字列/空白のみの場合はパースするまでもなく空の結果を返す。
  if (!sql.trim()) {
    return { markers: [], descriptors: [], tableReferences: [] };
  }
  try {
    const { markers, descriptors, tableReferences } = runParse(sql, catalog, schema);
    return { markers, descriptors, tableReferences };
  } catch (error) {
    // ANTLR や listener 側が想定外の例外を投げた場合のフォールバック。
    // 具体的な位置は分からないため 1 行目と 1 文字目にエラーマーカーを立てる。
    return {
      markers: [
        {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
          message: error instanceof Error ? error.message : 'SQL parse failed',
        },
      ],
      descriptors: [],
      tableReferences: [],
    };
  }
}

/**
 * Insert the phantom identifier at `offset` (character index into `sql`).
 *
 * `offset`（sql 中の文字インデックス、カーソル位置）にファントム識別子を挿入した
 * 新しい文字列を返す。前後を半角スペースで囲むことで、独立したトークンとして
 * 字句解析されるようにする。
 */
function insertPhantom(sql: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, sql.length));
  return `${sql.slice(0, clamped)} ${PHANTOM} ${sql.slice(clamped)}`;
}

/**
 * Token index of the inserted phantom — that token *is* the caret for c3.
 * Locating it by text is far more robust than offset arithmetic (the phantom
 * insertion shifts every following token, and trailing-space carets otherwise
 * resolve to the wrong index). Falls back to the last real token.
 *
 * 挿入したファントムトークンのトークンインデックスを返す（antlr4-c3 にとって
 * この位置が「カーソル」となる）。ファントム挿入によって後続のすべてのトークンの
 * オフセットがずれるため、オフセット計算でカーソル位置を求めるよりも、
 * ファントムのテキストそのものを検索する方が堅牢である（末尾に空白がある場合の
 * オフセット計算のズレも回避できる）。ファントムトークンが見つからない場合は
 * 最後の実トークン（EOF を除く）にフォールバックする。
 */
function caretTokenIndex(tokenStream: CommonTokenStream): number {
  const tokens = tokenStream.getTokens();
  const phantom = tokens.find((t) => t.text === PHANTOM);
  if (phantom) return phantom.tokenIndex;
  const real = tokens.filter((t) => t.type !== Token.EOF);
  return real.length ? real[real.length - 1]!.tokenIndex : 0;
}

/**
 * Lowercased, human-readable label for a keyword token type.
 *
 * ANTLR のトークン種別（数値）を、補完候補として表示できる読みやすい小文字の
 * ラベルに変換する。リテラル名（'SELECT' のようなクオート付き）を優先し、
 * なければシンボル名にフォールバックする。前後のクオートを取り除き、
 * アンダースコアを空白に置換して小文字化する。
 */
function keywordLabel(parser: SqlBaseParser, tokenType: number): string {
  const literal = parser.vocabulary.getLiteralName(tokenType);
  const symbolic = parser.vocabulary.getSymbolicName(tokenType);
  const raw = literal ?? symbolic ?? '';
  return raw.replace(/^'|'$/g, '').replace(/_/g, ' ').toLowerCase();
}

// antlr4-c3 に「これらの文法規則に到達したら、その規則の中身を展開して具体的な
// 候補（キーワードだけでなくルール内部のトークンも含む）を返してほしい」と伝える
// ための優先ルール集合。qualifiedName/relationPrimary はテーブル参照系、
// identifier/expression はカラム参照や式系の入力位置を検出するために使う。
const PREFERRED_RULES = new Set<number>([
  SqlBaseParser.RULE_qualifiedName,
  SqlBaseParser.RULE_identifier,
  SqlBaseParser.RULE_relationPrimary,
  SqlBaseParser.RULE_expression,
]);

/** Snippet expansions keyed by the keyword that triggers them. */
// 特定のキーワード候補が出た際に、あわせて提示する定型的なスニペット候補
// （Tab で次のプレースホルダーに移動できる Monaco スニペット構文）。
const SNIPPETS: Record<string, { label: string; insertText: string; detail: string }> = {
  select: {
    label: 'select … from …',
    insertText: 'SELECT ${1:*}\nFROM ${2:table}',
    detail: 'snippet',
  },
  with: {
    label: 'with cte as (…)',
    insertText: 'WITH ${1:cte} AS (\n  SELECT ${2:*} FROM ${3:table}\n)\nSELECT * FROM ${1:cte}',
    detail: 'snippet',
  },
  limit: {
    label: 'limit 100',
    insertText: 'LIMIT ${1:100}',
    detail: 'snippet',
  },
};

/**
 * Input to `collectCompletions`: the SQL source, caret offset, the synchronous
 * schema cache, and the current catalog/schema context.
 *
 * `collectCompletions` への入力。SQL ソース全文、カーソルの文字オフセット、
 * 同期読み取り可能なスキーマキャッシュ、現在の catalog/schema コンテキストを渡す。
 */
export interface CompletionContext {
  sql: string;
  /** Character offset of the caret into `sql`. */
  /** `sql` 中でのカーソル位置（文字インデックス）。 */
  offset: number;
  cache: SchemaCache;
  catalog?: string;
  schema?: string;
}

/**
 * Collect completion candidates at the caret. Synchronous: it reads whatever
 * the SchemaCache currently holds and fires async warmers as a side effect so
 * the next keystroke has more data. Never throws.
 *
 * カーソル位置における補完候補を収集する。同期関数であり、SchemaCache が
 * 「その時点までに」解決済みのデータをそのまま読むだけで、まだ無いデータは
 * 副作用として非同期ウォーマー（warmCatalogs 等）を発火させるだけに留める
 * （次のキー入力で改めて呼ばれたときに反映される）。例外は投げず、失敗時は
 * 空配列を返す。
 */
export function collectCompletions(ctx: CompletionContext): CompletionCandidate[] {
  const { sql, offset, cache, catalog, schema } = ctx;
  try {
    // カーソル位置にファントム識別子を挿入した上で再パースする。
    const phantomSql = insertPhantom(sql, offset);
    const { parser, tokenStream } = buildParser(phantomSql);
    // Re-run the listener on the phantom text to know the in-context table.
    // ファントムを含むテキストに対して listener を再度走らせ、「カーソルが
    // 属しているクエリはどのテーブルを参照しているか」を得る。
    const listener = new SqlBaseListenerImpl(catalog, schema);
    parser.addParseListener(listener);
    parser.removeErrorListeners();
    parser.singleStatement();
    tokenStream.fill();

    // ファントムトークンの位置を求め、antlr4-c3 にその位置での候補収集を依頼する。
    const caretIndex = caretTokenIndex(tokenStream);
    const core = new CodeCompletionCore(parser);
    core.showDebugOutput = false;
    // EOF トークンは候補として無意味なので除外する。
    core.ignoredTokens = new Set([Token.EOF]);
    core.preferredRules = PREFERRED_RULES;
    const candidates = core.collectCandidates(caretIndex);

    const out: CompletionCandidate[] = [];
    // (kind, label) の組で重複排除するためのセット。
    const seen = new Set<string>();
    const push = (c: CompletionCandidate) => {
      const key = `${c.kind}:${c.label}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };

    // 1. Keyword + snippet candidates from the grammar.
    // 1. 文法から得られるキーワードとスニペット候補。
    //    あわせて、antlr4-c3 が返した「到達可能なルール」を見て、この位置が
    //    「リレーション参照（テーブル名等）」なのか「式（カラム参照等）」なのかを
    //    判定しておく（後段のスキーマ候補収集で使う）。
    let expectsRelation = false;
    let expectsExpression = false;
    for (const ruleIndex of candidates.rules.keys()) {
      if (
        ruleIndex === SqlBaseParser.RULE_qualifiedName ||
        ruleIndex === SqlBaseParser.RULE_relationPrimary
      ) {
        expectsRelation = true;
      }
      if (
        ruleIndex === SqlBaseParser.RULE_identifier ||
        ruleIndex === SqlBaseParser.RULE_expression
      ) {
        expectsExpression = true;
      }
    }

    for (const tokenType of candidates.tokens.keys()) {
      const label = keywordLabel(parser, tokenType);
      // ラベルが空、EOF、または名前のない内部トークン（T__n）は候補から除外する。
      if (!label || label === 'eof' || label.startsWith('t__')) continue;
      // Skip pure punctuation keywords.
      // 記号だけのキーワード（アルファベットを含まない）はユーザーへの提示に
      // 意味が薄いのでスキップする。
      if (!/[a-z]/.test(label)) continue;
      push({
        label,
        insertText: label,
        kind: 'keyword',
        detail: 'keyword',
        sortPriority: 1,
      });
      // このキーワードに対応する定型スニペットがあれば、あわせて候補に追加する。
      const snip = SNIPPETS[label];
      if (snip) {
        push({
          label: snip.label,
          insertText: snip.insertText,
          kind: 'snippet',
          detail: snip.detail,
          sortPriority: 5,
          isSnippet: true,
        });
      }
    }

    // 2. Relation candidates: table FQNs, context-relative names, CTE names.
    // 2. リレーション候補: テーブルの完全修飾名、現在の文脈に対する相対名、CTE 名。
    if (expectsRelation) {
      // カタログ一覧・（分かっていれば）現在スキーマのテーブル一覧の取得を
      // 裏で開始しておく（結果が間に合わなくても次回の呼び出しで反映される）。
      cache.warmCatalogs();
      if (catalog && schema) cache.warmTables(catalog, schema);

      for (const fqn of cache.getTableNameList()) {
        push({ label: fqn, insertText: fqn, kind: 'table', detail: 'table', sortPriority: 8 });
        // Relative name when it matches the current context.
        // 完全修飾名が現在の catalog.schema と一致する接頭辞を持つ場合は、
        // 短い「相対名」（テーブル名のみ）も候補として追加する。
        if (catalog && schema && fqn.startsWith(`${catalog}.${schema}.`)) {
          const rel = fqn.slice(`${catalog}.${schema}.`.length);
          push({
            label: rel,
            insertText: rel,
            kind: 'table',
            detail: 'table (context)',
            sortPriority: 9,
          });
        }
      }
      // CTE / エイリアス名も候補に加える（テーブル名より優先度を高くする）。
      for (const cte of listener.namedQueries.keys()) {
        push({ label: cte, insertText: cte, kind: 'cte', detail: 'CTE', sortPriority: 10 });
      }
    }

    // 3. Column candidates from the in-context referenced table(s).
    // 3. カラム候補: 現在の文脈（カーソルを含むクエリ）が参照しているテーブルの
    //    カラム一覧から。
    if (expectsExpression || candidates.rules.has(SqlBaseParser.RULE_qualifiedName)) {
      // カーソルを含む最内 query scope と ancestor だけを対象にし、内側 query の
      // relation を外側の補完やキャッシュ warming へ漏らさない。
      for (const stmt of listener.getStatementsVisibleAt(caretIndex)) {
        const ref = refFor(stmt.tableName, catalog, schema);
        // まだ未取得ならウォーマーを起動（次回呼び出しで反映される）。
        cache.warmTable(ref);
        // 既にキャッシュ済みならそのカラム一覧を候補に変換する。
        const table = cache.getTableIfCached(ref);
        if (!table) continue;
        const cols = table.getColumns();
        for (const col of cols) {
          push({
            label: col.getName(),
            insertText: col.getName(),
            kind: 'column',
            detail: `${col.getType()} · ${ref.tableName}`,
            sortPriority: 7,
          });
        }
        // カラムが1つでもあれば、「全カラムを展開する」候補（SELECT 句を書くときに
        // カラム名をカンマ区切りで一括挿入できる）も追加する。
        if (cols.length > 0) {
          const list = cols.map((c) => c.getName()).join(',\n  ');
          push({
            label: `* all columns of ${ref.tableName}`,
            insertText: `  ${list}`,
            kind: 'columnList',
            detail: 'expand columns',
            sortPriority: 6,
          });
        }
      }
    }

    return out;
  } catch {
    // パース/補完処理のいずれかで例外が発生しても、補完機能自体は失敗させず
    // 単に候補なし（空配列）として扱う。
    return [];
  }
}

// analyzer.ts の内部でも使う TableReference を、他モジュール（index.ts 等）が
// この analyzer.ts 経由でも参照できるよう re-export する。
export { TableReference };

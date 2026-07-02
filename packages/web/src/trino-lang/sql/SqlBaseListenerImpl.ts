// Cache warming is driven explicitly by the analyzer layer from the table
// references this listener exposes. The visitor callbacks are typed and
// `getDescriptors` returns editor-agnostic descriptors.
//
// ---- ファイル概要（日本語） ----
// ANTLR が生成した `SqlBaseListener`（generated/SqlBaseListener.js）を継承し、
// パースツリーの走査（parser.addParseListener 経由でパース中に呼ばれる）中に
// 「テーブル名の位置」「CTE/エイリアスの名前」「SELECT リストの列名」「クエリ単位の
// 範囲」などを収集する listener 実装。analyzer.ts の `parseStatement` /
// `collectCompletions` がこのクラスのインスタンスを生成してパーサーに登録し、
// 収集結果（specialHighlights, namedQueries, statements など）を読み出して使う。
// キャッシュのウォーミング（SchemaCache への事前フェッチ指示）はこのクラス自身では
// 行わず、ここが公開するテーブル参照情報を使って analyzer.ts 側が明示的に行う
// （関心の分離）。各 visitor コールバックは ANTLR が生成した型付きコンテキストを
// 受け取り、`getDescriptors` はエディター（Monaco）に依存しないデコレーション
// 記述子を返す。

import type { ParserRuleContext } from 'antlr4ng';
import { SqlBaseListener } from '../generated/SqlBaseListener.js';
import {
  IdentifierContext,
  type QualifiedNameContext,
  type QuerySpecificationContext,
  SelectSingleContext,
  TableNameContext,
  type UnquotedIdentifierContext,
} from '../generated/SqlBaseParser.js';
import SpecialHighlight, { type HighlightDescriptor } from './SpecialHighlight';
import NamedQuery from './NamedQuery';
import StatementDescriptor from './StatementDescriptor';

/**
 * ANTLR のパースツリー走査中に、テーブル名のハイライト箇所、CTE/エイリアス名、
 * SELECT リストの列名、クエリ単位の範囲を収集する listener。
 * `parser.addParseListener(new SqlBaseListenerImpl(catalog, schema))` の形で
 * パーサーに登録して使う。
 */
class SqlBaseListenerImpl extends SqlBaseListener {
  // ハイライト対象（テーブル名など）として見つかった箇所の一覧。
  specialHighlights: SpecialHighlight[] = [];
  // リレーション名（テーブル名/CTE名/エイリアス名）→ そのリレーションが持つ
  // 列名一覧（SELECT リストから収集したもの）のマップ。
  tableColumns: Map<string, string[]> = new Map<string, string[]>();
  // CTE またはエイリアス付きリレーションとして参照可能な名前 → NamedQuery のマップ。
  // analyzer.ts の補完処理が「FROM 句の後で名乗れる名前」として利用する。
  namedQueries: Map<string, NamedQuery> = new Map<string, NamedQuery>();
  // 現在走査中の SELECT リストで見つかった列名（エイリアス考慮）を一時的に貯める。
  // exitQualifiedName / exitNamedQuery / exitAliasedRelation で対応するリレーション
  // 名に紐付けられ、その都度クリアされる。
  currentColumns: string[] = [];
  // 直近で見つかったテーブル名（querySpecification 内で FROM 句のテーブル参照が
  // 見つかったら設定される）。exitQuerySpecification で StatementDescriptor に使う。
  currentTableNameContext: string = '';
  // querySpecification（SELECT 文相当）ごとの記述子（主テーブル名 + ソース範囲）の一覧。
  statements: StatementDescriptor[] = [];

  // 補完/ハイライトの文脈として使う、現在のカタログ/スキーマ（相対テーブル名解決用）。
  currentCatalog?: string;
  currentSchema?: string;

  constructor(catalog?: string, schema?: string) {
    super();
    this.currentCatalog = catalog;
    this.currentSchema = schema;
  }

  // qualifiedName（"a.b.c" のような修飾名）ノードを抜けるたびに呼ばれる。
  // 親が TableNameContext（＝この修飾名がテーブル名として使われている）の場合のみ
  // 処理し、それ以外（カラム参照など）は無視する。
  override exitQualifiedName = (ctx: QualifiedNameContext) => {
    if (!(ctx.parent instanceof TableNameContext)) return;
    if (!ctx.start || !ctx.stop) return;

    // このテーブル名の位置情報と文脈（catalog/schema）を持つ SpecialHighlight を
    // 記録する。エディタ側はこれを装飾（ハイライト）とホバー解決の両方に使う。
    this.specialHighlights.push(
      new SpecialHighlight(
        ctx.start.line,
        ctx.start.column,
        ctx.stop.line,
        ctx.stop.column + (ctx.stop.stop - ctx.stop.start),
        'qualifiedName',
        ctx,
        this.currentCatalog,
        this.currentSchema,
      ),
    );

    // このテーブルを「現在のクエリが参照しているテーブル」として記録し、
    // これまでに集めた列名（currentColumns）をこのテーブル名に紐付けて確定する。
    const name = ctx.getText();
    this.currentTableNameContext = name;
    this.tableColumns.set(name, this.currentColumns);
    this.currentColumns = [];
  };

  // querySpecification（SELECT 文相当）に入るたびに、直前のクエリの状態を
  // 引きずらないよう currentTableNameContext をリセットする。
  override enterQuerySpecification = (_ctx: QuerySpecificationContext) => {
    this.currentTableNameContext = '';
  };

  // querySpecification を抜けるとき、そのクエリが参照していたテーブル名が
  // 判明していれば（currentTableNameContext が空でなければ）、クエリの範囲
  // （start/stop トークン）とあわせて StatementDescriptor として記録する。
  // analyzer.ts の補完処理が「カーソル位置のクエリはどのテーブルを見ているか」を
  // 判定するのに使う。
  override exitQuerySpecification = (ctx: QuerySpecificationContext) => {
    if (this.currentTableNameContext !== '' && ctx.start && ctx.stop) {
      this.statements.push(
        new StatementDescriptor(this.currentTableNameContext, ctx.start, ctx.stop),
      );
    }
  };

  // The name of a CTE.
  // CTE（WITH 句で定義される名前付きクエリ）の名前を抜けるときに呼ばれる。
  // 最初の子ノードが識別子であれば、その名前を「参照可能な名前」として
  // namedQueries に登録し、それまでに集めた列名を紐付ける。
  override exitNamedQuery = (ctx: ParserRuleContext) => {
    const first = ctx.children?.[0];
    if (first instanceof IdentifierContext) {
      const name = first.getText();
      this.namedQueries.set(name, new NamedQuery(name, ctx));
      this.tableColumns.set(name, this.currentColumns);
      this.currentColumns = [];
    }
  };

  // The name of an aliased relation.
  // エイリアス付きリレーション（例: "FROM foo AS f"）を抜けるときに呼ばれる。
  // 3 番目の子ノード（"relation AS alias" のうち alias 部分。文法上インデックス2）
  // が識別子であれば、そのエイリアス名を参照可能な名前として登録する。
  override exitAliasedRelation = (ctx: ParserRuleContext) => {
    const alias = ctx.children?.[2];
    if (alias instanceof IdentifierContext) {
      const name = alias.getText();
      this.namedQueries.set(name, new NamedQuery(name, ctx));
      this.tableColumns.set(name, this.currentColumns);
      this.currentColumns = [];
    }
  };

  // 引用符なしの識別子ノードを抜けるたびに呼ばれる。SELECT リストの列名/列
  // エイリアスを収集するために、祖先ノードを遡って SelectSingleContext
  // （SELECT リストの 1 項目）を探す。
  override exitUnquotedIdentifier = (ctx: UnquotedIdentifierContext) => {
    // Walk up to the enclosing SelectSingle to detect a column alias.
    // 対象の識別子を包む SelectSingleContext（SELECT リストの 1 要素）まで
    // 親をたどる。見つからなければ SELECT リストの一部ではないので何もしない。
    let current: ParserRuleContext | null = ctx;
    while (current && !(current instanceof SelectSingleContext)) {
      current = current.parent;
    }
    if (!current) return;

    // SelectSingle の子が複数ある場合（例: "expr AS alias"）は、最後の子
    // （エイリアス部分）のテキストを列名として採用する。子が 1 つしかない場合
    // （エイリアスなし、単純な列参照）は識別子自体のテキストをそのまま使う。
    const children = current.children ?? [];
    if (children.length > 1) {
      const last = children[children.length - 1];
      if (last) this.currentColumns.push(last.getText());
    } else {
      this.currentColumns.push(ctx.getText());
    }
  };

  /**
   * Names referenceable as relations (CTE / aliased) → for completion.
   *
   * リレーションとして参照可能な名前（CTE / エイリアス）の一覧を、補完候補生成用に
   * 名前→名前の Map として返す（SpecialHighlight.getDescriptor に渡す形式に合わせる）。
   */
  getNamedQueryNames(): Map<string, string> {
    const map = new Map<string, string>();
    for (const name of this.namedQueries.keys()) map.set(name, name);
    return map;
  }

  /**
   * Editor-agnostic decoration descriptors for every table-name highlight.
   *
   * 収集したすべてのテーブル名ハイライト箇所を、エディター（Monaco）に依存しない
   * デコレーション記述子（HighlightDescriptor）の配列に変換して返す。
   */
  getDescriptors(): HighlightDescriptor[] {
    const named = this.getNamedQueryNames();
    return this.specialHighlights.map((h) => h.getDescriptor(named));
  }
}

export default SqlBaseListenerImpl;

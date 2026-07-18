/*
 * このファイルの責務:
 * SchemaTree / TableDetailPopover から挿入、生成する SQL 文字列の組み立てロジックを
 * 集約した純粋関数群（React に依存しない）。テーブル名の相対表記（bare / schema.table /
 * catalog.schema.table）の判定と、Trino 識別子のクォート規則、SELECT 雛形の生成を担う。
 * 画面上の位置づけとしては、データブラウザのツリーやテーブル詳細ポップオーバーから
 * 「クリックでエディタに何を挿入するか」を決めるための下請けモジュール。
 * Trino 識別子は素の小文字識別子でない場合だけダブルクォートで囲む
 * （tpch の一般的なケース `orders` を読みやすいまま保ちつつ、大文字混在や
 * 予約語などの識別子 `"My Table"` でも正しく扱えるようにするため）。
 */

// 素の（クォート不要な）Trino 識別子の形: 小文字英字またはアンダースコアで始まり、
// 以降は小文字英数字とアンダースコアのみ。これに一致しない名前はダブルクォートが必要。
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Trino 識別子を必要な場合だけダブルクォートで囲む。
 * @param name クォート対象の識別子（テーブル名、カラム名、スキーマ名など）。
 * @returns 素の識別子ならそのまま、それ以外はダブルクォートで囲んだ文字列。
 */
export function quoteIdentifier(name: string): string {
  // 素の識別子ならそのまま返す（tpch.sf1.orders のような一般的なケースを読みやすく保つ）。
  if (PLAIN_IDENTIFIER.test(name)) return name;
  // それ以外（大文字混在、空白、予約語など）はダブルクォートで囲み、内部の " は "" に
  // エスケープする（Trino/ANSI SQL の識別子エスケープ規則）。
  return `"${name.replace(/"/g, '""')}"`;
}

/** テーブルを一意に指す catalog/schema/name の組（FQN の構成要素）。 */
export interface TableRef {
  catalog: string;
  schema: string;
  name: string;
}

/** 現在エディタが属している catalog/schema（相対名の基準となるコンテキスト）。 */
export interface EditorContext {
  catalog?: string;
  schema?: string;
}

/**
 * カーソル位置に挿入するテーブル名を、現在のエディタコンテキストに対して
 * 「どこまで省略できるか」で決定する。同一 catalog/schema ならテーブル名のみ、
 * 同一 catalog だが別 schema なら `schema.table`、catalog も異なるなら
 * 完全修飾名 `catalog.schema.table` を返す。各部分は必要な場合のみクォートされる。
 * @param ref 挿入対象テーブルの catalog/schema/name。
 * @param ctx 現在のエディタコンテキスト（アクティブなセルの catalog/schema）。
 * @returns カーソル位置に挿入する文字列（相対名または完全修飾名）。
 */
export function relativeTableName(ref: TableRef, ctx: EditorContext): string {
  // まずテーブル名自体をクォート要否判定。
  const t = quoteIdentifier(ref.name);
  // catalog と schema ともにコンテキストと一致するなら、テーブル名だけで曖昧さがない。
  if (ctx.catalog === ref.catalog && ctx.schema === ref.schema) return t;
  const s = quoteIdentifier(ref.schema);
  // catalog だけ一致するなら schema.table で足りる。
  if (ctx.catalog === ref.catalog) return `${s}.${t}`;
  // catalog も異なる（またはコンテキスト未設定）なら完全修飾名が必要。
  const c = quoteIdentifier(ref.catalog);
  return `${c}.${s}.${t}`;
}

/**
 * テーブル詳細ポップオーバーの「SELECT 雛形を新規セルへ」ボタンから使われる、
 * SELECT 文の雛形生成関数。カラム一覧が既知ならそれを列挙し、未知なら `*` を使う。
 * FROM 句のテーブル名は relativeTableName と同じ相対名規則で組み立てられる。
 * @param ref 対象テーブルの catalog/schema/name。
 * @param columns 列挙するカラム名の一覧（空配列なら `*` を使う）。
 * @param ctx 現在のエディタコンテキスト（相対名判定に使う）。
 * @param limit LIMIT 句に使う行数（デフォルト 100）。
 * @returns 生成された `SELECT ... FROM ... LIMIT ...` の SQL 文字列。
 */
export function selectTemplate(
  ref: TableRef,
  columns: string[],
  ctx: EditorContext,
  limit = 100,
): string {
  // カラム一覧が既知（テーブル詳細を取得済み）なら列挙し、未知なら * にフォールバック。
  const cols = columns.length > 0 ? columns.map(quoteIdentifier).join(', ') : '*';
  // FROM 句のテーブル名は relativeTableName と同じ規則で組み立てる（表記の一貫性）。
  const from = relativeTableName(ref, ctx);
  return `SELECT ${cols}\nFROM ${from}\nLIMIT ${limit}`;
}

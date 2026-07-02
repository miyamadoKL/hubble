// Pure tree-filtering logic for the Data browser (design.md §5: 検索フィルタ,
// マッチパスは自動展開). Lifted out of the React component so the lazy-load
// expansion behaviour is unit-testable without rendering Monaco / TanStack.
//
// The browser lazy-loads children on expand, so a filter can only "see into"
// branches whose children are already cached. `expandedForFilter` augments the
// user's manual expansion set with any already-loaded catalog/schema that
// contains a matching table — so the match surfaces — while leaving unloaded
// branches untouched (the filter genuinely can't reach them, and that's fine).

/*
 * このファイルの責務:
 * SchemaTree の検索フィルタ（design.md §5）に関する純粋関数を集約する。React 非依存の
 * ロジックとして切り出すことで、Monaco / TanStack Query をレンダリングせずに
 * ユニットテストできるようにしている。画面上は、データブラウザ上部の検索ボックスに
 * 入力した文字列が、ツリーの表示絞り込みと自動展開の両方に反映される仕組みを支える。
 */

/**
 * 現在すでに（TanStack Query のキャッシュに）読み込み済みのツリー部分を表す型。
 * フィルタは、この構造に含まれる catalog/schema/table しか「見る」ことができない。
 */
export interface LoadedTree {
  /** schema names by catalog, for catalogs whose schema list is cached. */
  /** catalog 名 → 読み込み済みスキーマ名一覧。まだ展開されていない catalog は含まれない。 */
  schemasByCatalog: Map<string, string[]>;
  /** table names by `${catalog}::${schema}`, for cached table lists. */
  /** `catalog::schema` キー → 読み込み済みテーブル名一覧。まだ展開されていない schema は含まれない。 */
  tablesBySchema: Map<string, string[]>;
}

/**
 * catalog + schema からツリーノードの一意キーを組み立てる（expandedKeys / キャッシュの
 * Map キーとして両方で使われるため、キー生成をここに一元化している）。
 * @param catalog カタログ名。
 * @param schema スキーマ名。
 * @returns `catalog::schema` 形式のキー文字列。
 */
export function schemaKey(catalog: string, schema: string): string {
  return `${catalog}::${schema}`;
}

/**
 * Case-insensitive substring match (empty needle matches everything).
 *
 * 大文字小文字を無視した部分一致判定。needle が空文字なら常に true を返す
 * （フィルタ未入力時は全件表示にするため）。
 * @param value 検査対象の文字列（テーブル名、カラム名など）。
 * @param needle 検索語（空文字なら無条件マッチ）。
 * @returns value が needle を含んでいれば true。
 */
export function matchesNeedle(value: string, needle: string): boolean {
  // needle が空文字なら何にでもマッチさせる（フィルタ未入力時は全件表示にするため）。
  return !needle || value.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Given the user's explicit `expanded` set, a `needle`, and the currently-loaded
 * tree, return the set of node keys that should render as expanded. With no
 * needle the explicit set is returned unchanged. With a needle, any loaded
 * catalog/schema that (transitively) contains a matching table is added so the
 * match is visible.
 *
 * Node keys: a catalog is keyed by its name; a schema by `catalog::schema`.
 *
 * ユーザーの手動展開集合 `expanded` に、検索文字列 `needle` にマッチするテーブルを
 * 含む「既に読み込み済みの」catalog/schema を自動的に追加した展開集合を返す。
 * needle が空なら手動展開集合をそのまま返す。まだ読み込まれていないブランチは
 * フィルタが中を見られないため対象外のまま（それで問題ない）。
 * ノードキーの形式: catalog はその名前そのもの、schema は `catalog::schema`。
 * @param expanded ユーザーが手動でクリックして開いたノードキーの集合。
 * @param needle 検索文字列（前後空白、大文字小文字は無視される）。
 * @param loaded 現在キャッシュに読み込み済みの catalog/schema/table 一覧。
 * @returns 自動展開分を加味した、実際に展開状態としてレンダリングすべきキー集合。
 */
export function expandedForFilter(
  expanded: ReadonlySet<string>,
  needle: string,
  loaded: LoadedTree,
): Set<string> {
  const trimmed = needle.trim().toLowerCase();
  // needle が空ならユーザーの手動展開状態をそのまま返す（自動展開の必要がない）。
  if (!trimmed) return new Set(expanded);

  // 手動展開集合をコピーし、そこにマッチを含む既読み込みブランチを追加していく
  // （ユーザーが手動で開いたノードを勝手に閉じないよう、既存の集合は保持する）。
  const next = new Set(expanded);
  for (const [catalog, schemas] of loaded.schemasByCatalog) {
    let catalogHasMatch = false;
    for (const schema of schemas) {
      // このスキーマのテーブル一覧がまだキャッシュされていなければフィルタで
      // 見ることができないので諦めて次へ（未ロード分岐は自動展開しない）。
      const tables = loaded.tablesBySchema.get(schemaKey(catalog, schema));
      if (!tables) continue;
      if (tables.some((t) => matchesNeedle(t, trimmed))) {
        // マッチするテーブルがあればそのスキーマを展開し、上位カタログの展開も予約する。
        next.add(schemaKey(catalog, schema));
        catalogHasMatch = true;
      }
    }
    if (catalogHasMatch) next.add(catalog);
  }
  return next;
}

/**
 * Filter a node's children by the needle. With no needle, the list is returned
 * as-is; otherwise only matching names survive. Shared by table and column
 * lists so filtering stays consistent.
 *
 * ツリーの子要素一覧（テーブル一覧、カラム一覧など）を検索文字列で絞り込む汎用関数。
 * needle が空ならフィルタせずそのまま返す。テーブル/カラムなど異なる型の一覧で
 * 同じフィルタ挙動を再利用できるよう、要素から比較対象の文字列を取り出す
 * `name` アクセサを引数に取る。
 * @param items フィルタ対象の要素一覧。
 * @param name 各要素から比較用の文字列（名前）を取り出す関数。
 * @param needle 検索文字列（前後空白、大文字小文字は無視される）。
 * @returns needle にマッチした要素のみを含む配列（needle が空なら items をそのまま）。
 */
export function filterByNeedle<T>(items: T[], name: (item: T) => string, needle: string): T[] {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return items;
  // name アクセサ経由で対象の文字列を取り出し、matchesNeedle で絞り込む
  // （テーブルの列やカラムの列など、異なる型の一覧で同じフィルタ挙動を再利用するため）。
  return items.filter((i) => matchesNeedle(name(i), trimmed));
}

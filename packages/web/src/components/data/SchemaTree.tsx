import { useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronRight,
  Database,
  Hash,
  Info,
  Layers,
  RefreshCw,
  Table2,
  Type,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Column } from '@hubble/contracts';
import {
  fetchCatalogs,
  fetchSchemas,
  fetchTables,
  fetchTableDetail,
  metadataQueryKeys,
  META_STALE_MS,
  refreshMetadata,
} from '../../api/metadata';
import { insertAtActiveCursor } from '../../notebook';
import { relativeTableName, quoteIdentifier } from './tableName';
import { expandedForFilter, filterByNeedle, schemaKey, type LoadedTree } from './treeFilter';
import { TableDetailPopover, type TableTarget } from './TableDetailPopover';
import { Spinner } from '../common/Spinner';
import { IconButton } from '../common/IconButton';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';

/**
 * Data browser tree (design.md §5): catalog → schema → table → column, lazy-
 * loaded on expand (TanStack Query, stale 5 min). A client-side filter narrows
 * already-loaded nodes and auto-expands matched paths; unloaded branches are
 * left collapsed (the filter can't reach them, which is fine). Clicking a table
 * inserts its context-relative name at the caret; clicking a column inserts its
 * name. A per-row info button opens the table detail popover; a header button
 * refreshes the server cache and invalidates the tree.
 */

/*
 * このファイルの責務:
 * アシストサイドバーの「データブラウザ」タブ本体。catalog → schema → table → column
 * の4階層ツリーを、展開されたノードだけ TanStack Query 経由で遅延取得しながら描画する。
 * 画面上の位置づけとしては、SQL エディタの左に置かれるサイドバーの1タブであり、
 * ここでの操作（テーブル/カラムのクリック）が編集中のカーソル位置へ SQL 断片を挿入する
 * 入口になっている。テーブル詳細ポップオーバー（TableDetailPopover）の起動もここから行う。
 */

// カラムの型名（Trino の型文字列）が数値系かどうかを判定する正規表現。
// bigint/integer/int/smallint/tinyint/double/real/decimal/float のいずれかで始まれば数値扱い。
const NUMERIC = /^(bigint|integer|int|smallint|tinyint|double|real|decimal|float)/i;

// カラムの型名に応じてツリー行に表示するアイコンを切り替える（数値型は Hash、それ以外は Type）。
function columnIcon(type: string): LucideIcon {
  return NUMERIC.test(type) ? Hash : Type;
}

/**
 * SchemaTree が挿入するテーブル名を「どこまで省略できるか」判定するための現在の
 * エディタコンテキスト。アクティブなセルが属する catalog/schema と一致していれば、
 * 挿入されるテーブル名はその分だけ短く（bare name や schema.table）表記される。
 */
export interface SchemaTreeContext {
  catalog?: string;
  schema?: string;
}

// ---- Generic row -----------------------------------------------------------

// ツリーの1行を汎用的に描画するための props。catalog/schema/table/column いずれの
// 階層でも共通の見た目（インデント、アイコン、ラベル、展開矢印）を出すために使う。
interface TreeRowProps {
  /** ツリーの深さ（0 = catalog）。インデント幅の計算に使う。 */
  depth: number;
  /** 行頭に表示するアイコン。 */
  icon: LucideIcon;
  /** アイコンに付ける追加の Tailwind クラス（色分けなど）。 */
  iconClass?: string;
  /** 行のメインラベル（catalog 名、table 名など）。 */
  label: string;
  /** ラベル右側に薄く出す補助情報（件数や型名）。 */
  meta?: string;
  /** true なら展開用のシェブロンを表示し、クリックで onToggle を呼べるようにする。 */
  expandable?: boolean;
  /** 展開中かどうか（シェブロンの回転表示に使う）。 */
  expanded?: boolean;
  /** 選択中（挿入対象など）としてハイライトするか。 */
  selected?: boolean;
  /** シェブロンや行クリックで展開/折りたたみを切り替えるハンドラ。 */
  onToggle?: () => void;
  /** 行本体のクリック（挿入やクエリ発行のトリガー）ハンドラ。 */
  onSelect?: () => void;
  /** 行右端に追加で表示する要素（詳細ボタンなど）。 */
  trailing?: React.ReactNode;
}

function TreeRow({
  depth,
  icon: Icon,
  iconClass,
  label,
  meta,
  expandable = false,
  expanded = false,
  selected = false,
  onToggle,
  onSelect,
  trailing,
}: TreeRowProps) {
  return (
    <div
      className={cn(
        'group/row flex h-7 items-center pr-1',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
      )}
    >
      <button
        type="button"
        onClick={() => {
          // 行クリックで選択（SQL 挿入など）と、展開可能なら展開/折りたたみを同時に行う。
          onSelect?.();
          if (expandable) onToggle?.();
        }}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
      >
        {/* 展開可能な行だけシェブロンを表示し、展開中は90度回転させる。
            展開不可の行（カラム行など）は同じ幅のダミー要素でインデントを揃える。 */}
        {expandable ? (
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={cn('shrink-0 text-ink-subtle transition-transform', expanded && 'rotate-90')}
          />
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <Icon
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0', selected ? 'text-accent' : (iconClass ?? 'text-ink-muted'))}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-xs',
            selected ? 'text-accent' : 'text-ink-base',
          )}
        >
          {label}
        </span>
        {meta && <span className="shrink-0 font-mono text-2xs text-ink-subtle">{meta}</span>}
      </button>
      {trailing}
    </div>
  );
}

/** A small inline status line (loading / error / empty) under an open node. */
function NodeStatus({
  depth,
  state,
  onRetry,
  emptyLabel = 'Empty',
}: {
  depth: number;
  state: 'loading' | 'error' | 'empty';
  onRetry?: () => void;
  emptyLabel?: string;
}) {
  return (
    <div
      style={{ paddingLeft: `${depth * 14 + 26}px` }}
      className="flex h-6 items-center gap-1.5 pr-2 font-mono text-2xs text-ink-subtle"
    >
      {/* state に応じて loading / empty / error のいずれか1つだけを表示する
          （3状態は排他的で、通常は複数が同時に真になることはない）。 */}
      {state === 'loading' && (
        <>
          <Spinner size={11} /> Loading…
        </>
      )}
      {state === 'empty' && <span className="text-ink-subtle italic">{emptyLabel}</span>}
      {state === 'error' && (
        <>
          <AlertCircle size={11} className="text-error" />
          <span className="text-error">Failed</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-accent underline-offset-2 hover:underline"
            >
              retry
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ---- Column list (under an expanded table) ---------------------------------

// 展開されたテーブルの下に並ぶカラム一覧。テーブル詳細（columns）はすでに取得済みの
// データを渡されるだけで、ここでは検索フィルタの適用と行の描画だけを行う。
function ColumnList({
  columns,
  depth,
  needle,
  onInsertColumn,
}: {
  columns: Column[];
  depth: number;
  needle: string;
  onInsertColumn: (name: string) => void;
}) {
  // needle（検索文字列）に一致するカラムだけを表示対象にする。
  const visible = filterByNeedle(columns, (c) => c.name, needle);
  return (
    <>
      {/* フィルタ後のカラム一覧を1行ずつ TreeRow として描画する（クリックでカラム名を挿入）。 */}
      {visible.map((col) => (
        <TreeRow
          key={col.name}
          depth={depth}
          icon={columnIcon(col.type)}
          label={col.name}
          meta={col.type}
          onSelect={() => onInsertColumn(col.name)}
        />
      ))}
    </>
  );
}

// ---- Table node ------------------------------------------------------------

// テーブル1件分のツリーノード。展開されるとカラム一覧を遅延取得して表示する。
// クリックでコンテキスト相対のテーブル名をカーソル位置へ挿入し、行右端の
// 情報アイコンからテーブル詳細ポップオーバーを開ける。
function TableNode({
  datasourceId,
  catalog,
  schema,
  table,
  type,
  depth,
  needle,
  context,
  expanded,
  onToggle,
  onShowDetail,
}: {
  datasourceId: string;
  catalog: string;
  schema: string;
  table: string;
  type?: string;
  depth: number;
  needle: string;
  context: SchemaTreeContext;
  expanded: boolean;
  onToggle: () => void;
  onShowDetail: (target: TableTarget) => void;
}) {
  // テーブル詳細（カラム一覧、コメント）は expanded の間だけ取得する（enabled: expanded）。
  // これがこのツリーの「遅延読み込み」の核心である。折りたたまれたテーブルのために
  // 無駄なリクエストを発行しない。
  const detail = useQuery({
    queryKey: metadataQueryKeys.table(datasourceId, catalog, schema, table),
    queryFn: () => fetchTableDetail(datasourceId, catalog, schema, table),
    enabled: expanded,
    staleTime: META_STALE_MS,
  });

  // 詳細ポップオーバーに渡す対象テーブルの識別情報。
  const target: TableTarget = { catalog, schema, name: table, type };

  // テーブル名をコンテキストに応じた相対名に変換してカーソル位置へ挿入する
  // （同一 catalog/schema なら bare name、そうでなければ schema.table や完全修飾名）。
  const insertTable = () => {
    const text = relativeTableName({ catalog, schema, name: table }, context);
    insertAtActiveCursor(text);
  };

  return (
    <>
      <TreeRow
        depth={depth}
        icon={Table2}
        iconClass={type === 'VIEW' ? 'text-running' : 'text-ink-muted'}
        label={table}
        expandable
        expanded={expanded}
        onToggle={onToggle}
        onSelect={insertTable}
        trailing={
          <button
            type="button"
            aria-label={`Details for ${table}`}
            onClick={(e) => {
              // 行本体のクリック（テーブル名挿入 + 展開トグル）を発火させないよう伝播を止める。
              e.stopPropagation();
              onShowDetail(target);
            }}
            className="shrink-0 rounded-sm p-1 text-ink-subtle opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-accent focus-visible:opacity-100"
          >
            <Info size={13} strokeWidth={1.75} />
          </button>
        }
      />
      {expanded && (
        <>
          {/* 詳細取得中はローディング表示、失敗時はリトライ可能なエラー表示。 */}
          {detail.isPending && <NodeStatus depth={depth + 1} state="loading" />}
          {detail.isError && (
            <NodeStatus depth={depth + 1} state="error" onRetry={() => void detail.refetch()} />
          )}
          {detail.data && detail.data.columns.length === 0 && (
            <NodeStatus depth={depth + 1} state="empty" emptyLabel="No columns" />
          )}
          {detail.data && (
            <ColumnList
              columns={detail.data.columns}
              depth={depth + 1}
              needle={needle}
              onInsertColumn={(name) => insertAtActiveCursor(quoteIdentifier(name))}
            />
          )}
        </>
      )}
    </>
  );
}

// ---- Schema node -----------------------------------------------------------

// スキーマ1件分のツリーノード。展開されるとそのスキーマ配下のテーブル一覧を遅延取得し、
// 検索フィルタで絞り込んだうえで各テーブルを TableNode として描画する。
function SchemaNode({
  datasourceId,
  catalog,
  schema,
  depth,
  needle,
  context,
  expanded,
  expandedKeys,
  toggle,
  onShowDetail,
}: {
  datasourceId: string;
  catalog: string;
  schema: string;
  depth: number;
  needle: string;
  context: SchemaTreeContext;
  expanded: boolean;
  expandedKeys: Set<string>;
  toggle: (key: string) => void;
  onShowDetail: (target: TableTarget) => void;
}) {
  // テーブル一覧も expanded の間だけ取得（遅延読み込み）。
  const tables = useQuery({
    queryKey: metadataQueryKeys.tables(datasourceId, catalog, schema),
    queryFn: () => fetchTables(datasourceId, catalog, schema),
    enabled: expanded,
    staleTime: META_STALE_MS,
  });

  // 取得済みテーブル一覧を検索文字列で絞り込む（needle が空なら全件）。
  const visible = useMemo(
    () => filterByNeedle(tables.data?.items ?? [], (t) => t.name, needle),
    [tables.data, needle],
  );

  return (
    <>
      <TreeRow
        depth={depth}
        icon={Layers}
        label={schema}
        meta={tables.data ? String(tables.data.items.length) : undefined}
        expandable
        expanded={expanded}
        onToggle={() => toggle(`${catalog}::${schema}`)}
      />
      {/* 展開中のみテーブル一覧を描画: 読み込み中/エラー/空（フィルタ該当なしを含む）の
          状態表示のあと、絞り込み済みテーブルをそれぞれ TableNode として再帰的に描画する。 */}
      {expanded && (
        <>
          {tables.isPending && <NodeStatus depth={depth + 1} state="loading" />}
          {tables.isError && (
            <NodeStatus depth={depth + 1} state="error" onRetry={() => void tables.refetch()} />
          )}
          {tables.data && visible.length === 0 && (
            <NodeStatus
              depth={depth + 1}
              state="empty"
              emptyLabel={needle ? 'No matches' : 'No tables'}
            />
          )}
          {visible.map((t) => {
            // 展開状態は「catalog::schema::table」の一意キーで expandedKeys 集合に
            // 保持される（Set を各ノードへ横流しし、トグル関数だけを子に渡す設計）。
            const key = `${catalog}::${schema}::${t.name}`;
            return (
              <TableNode
                key={t.name}
                datasourceId={datasourceId}
                catalog={catalog}
                schema={schema}
                table={t.name}
                type={t.type}
                depth={depth + 1}
                needle={needle}
                context={context}
                expanded={expandedKeys.has(key)}
                onToggle={() => toggle(key)}
                onShowDetail={onShowDetail}
              />
            );
          })}
        </>
      )}
    </>
  );
}

// ---- Catalog node ----------------------------------------------------------

// ツリーの最上位ノード（catalog）。展開されるとスキーマ一覧を遅延取得し、
// 各スキーマを SchemaNode として描画する。expandedKeys / toggle はそのまま
// 下位ノードへ橋渡しし、展開状態の単一の真実の情報源をルートに保つ。
function CatalogNode({
  datasourceId,
  catalog,
  needle,
  context,
  expanded,
  expandedKeys,
  toggle,
  onShowDetail,
  hideCatalogRow = false,
}: {
  datasourceId: string;
  catalog: string;
  needle: string;
  context: SchemaTreeContext;
  expanded: boolean;
  expandedKeys: Set<string>;
  toggle: (key: string) => void;
  onShowDetail: (target: TableTarget) => void;
  /** true のときカタログ行を描画せず schema 階層だけをルートに出す。 */
  hideCatalogRow?: boolean;
}) {
  // スキーマ一覧も expanded の間だけ取得（遅延読み込み）。
  const schemas = useQuery({
    queryKey: metadataQueryKeys.schemas(datasourceId, catalog),
    queryFn: () => fetchSchemas(datasourceId, catalog),
    enabled: expanded,
    staleTime: META_STALE_MS,
  });

  const schemaDepth = hideCatalogRow ? 0 : 1;
  const statusDepth = hideCatalogRow ? 0 : 1;

  return (
    <>
      {!hideCatalogRow && (
        <TreeRow
          depth={0}
          icon={Database}
          iconClass="text-accent"
          label={catalog}
          meta={schemas.data ? String(schemas.data.items.length) : undefined}
          expandable
          expanded={expanded}
          onToggle={() => toggle(catalog)}
        />
      )}
      {/* 展開中のみスキーマ一覧を描画: 読み込み中/エラー/空の状態表示のあと、
          スキーマごとに SchemaNode を再帰的なツリーの次階層として描画する。 */}
      {expanded && (
        <>
          {schemas.isPending && <NodeStatus depth={statusDepth} state="loading" />}
          {schemas.isError && (
            <NodeStatus depth={statusDepth} state="error" onRetry={() => void schemas.refetch()} />
          )}
          {schemas.data && schemas.data.items.length === 0 && (
            <NodeStatus depth={statusDepth} state="empty" emptyLabel="No schemas" />
          )}
          {(schemas.data?.items ?? []).map((s) => (
            <SchemaNode
              key={s.name}
              datasourceId={datasourceId}
              catalog={catalog}
              schema={s.name}
              depth={schemaDepth}
              needle={needle}
              context={context}
              expanded={expandedKeys.has(`${catalog}::${s.name}`)}
              expandedKeys={expandedKeys}
              toggle={toggle}
              onShowDetail={onShowDetail}
            />
          ))}
        </>
      )}
    </>
  );
}

// ---- Root ------------------------------------------------------------------

/**
 * データブラウザのツリー本体（サイドバーの「データ」タブから使われるエクスポート）。
 * catalog 一覧をルートに、展開されたノードから順に schema → table → column を
 * 遅延取得して描画する。`filter` は検索文字列（親のテキストボックスから渡される）、
 * `context` はテーブル名挿入時の相対名判定に使う現在の catalog/schema。
 */
export function SchemaTree({
  filter = '',
  context = {},
  datasourceId,
  flattenCatalog = false,
}: {
  /** 検索フィルタ文字列（未入力なら全件表示、自動展開なし）。 */
  filter?: string;
  /** 挿入するテーブル名を相対表記にするための現在のエディタコンテキスト。 */
  context?: SchemaTreeContext;
  /** 選択中データソース id。 */
  datasourceId: string;
  /** true のとき合成カタログ 1 件分を畳み、schema から表示する。 */
  flattenCatalog?: boolean;
}) {
  const queryClient = useQueryClient();
  // ユーザーが手動でクリックして開閉したノードキーの集合（catalog / catalog::schema /
  // catalog::schema::table のいずれか）。ツリー全体の展開状態の単一の真実の情報源。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // 詳細ポップオーバーで表示中のテーブル（null なら非表示）。
  const [detailTarget, setDetailTarget] = useState<TableTarget | null>(null);

  // ルートの catalog 一覧はツリーが常に表示するので expanded 条件なしで即時取得する。
  const catalogs = useQuery({
    queryKey: metadataQueryKeys.catalogs(datasourceId),
    queryFn: () => fetchCatalogs(datasourceId),
    staleTime: META_STALE_MS,
  });

  const syntheticCatalog =
    flattenCatalog && catalogs.data?.items.length === 1 ? catalogs.data.items[0]!.name : undefined;

  // 展開状態のトグル。キーが既に開いていれば閉じ、閉じていれば開く（Set の出し入れ）。
  // 各ノードへはこの関数と expandedKeys をそのまま渡し、状態管理をルートに集約する。
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ヘッダーの更新ボタン用ミューテーション: サーバー側の TTL キャッシュを強制更新させ、
  // 成功したらクライアント側の 'metadata' クエリを全て無効化してツリーを最新化する。
  const refresh = useMutation({
    mutationFn: () => refreshMetadata(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['metadata', datasourceId] });
      toast.info('Metadata refreshed', 'Schema cache reloaded.');
    },
    onError: () => toast.error('Refresh failed', 'Could not reach the server.'),
  });

  // 検索文字列を正規化（前後空白除去、小文字化）してから各ノードへ配る。
  const needle = filter.trim().toLowerCase();

  // While filtering, auto-expand already-loaded branches that contain a match so
  // the matched table/column surfaces without manual clicking (design.md §5:
  // マッチパスは自動展開). Unloaded branches are untouched — the filter can't see
  // into them, and that's acceptable. The auto-expand math lives in the pure
  // `treeFilter` module (unit-tested); here we just feed it the cached tree.
  const effectiveExpanded = useMemo(() => {
    // needle がなければ自動展開は不要のため、手動展開集合をそのまま使う。
    if (!needle) return expanded;
    // TanStack Query のキャッシュから「今すでに読み込み済みの」schema/table 一覧だけを
    // 拾い集めて LoadedTree を組み立てる（未読み込みの分岐は治外法権のまま）。
    const loaded: LoadedTree = { schemasByCatalog: new Map(), tablesBySchema: new Map() };
    for (const cat of catalogs.data?.items ?? []) {
      const schemas = queryClient.getQueryData(
        metadataQueryKeys.schemas(datasourceId, cat.name),
      ) as { items: { name: string }[] } | undefined;
      // このカタログのスキーマ一覧がまだキャッシュにない（未展開）なら諦めて次のカタログへ。
      if (!schemas) continue;
      loaded.schemasByCatalog.set(
        cat.name,
        schemas.items.map((s) => s.name),
      );
      for (const s of schemas.items) {
        const tables = queryClient.getQueryData(
          metadataQueryKeys.tables(datasourceId, cat.name, s.name),
        ) as { items: { name: string }[] } | undefined;
        if (tables) {
          loaded.tablesBySchema.set(
            schemaKey(cat.name, s.name),
            tables.items.map((t) => t.name),
          );
        }
      }
    }
    // 実際の自動展開判定はテスト済みの純粋関数（treeFilter）に委譲する。
    return expandedForFilter(expanded, needle, loaded);
    // queryClient cache reads are snapshot-in-render; recompute when the needle,
    // the loaded catalogs, or the explicit expansion set changes.
  }, [needle, expanded, catalogs.data, queryClient, datasourceId]);

  return (
    <div>
      {/* ヘッダー行: 現在の catalog 件数表示と、メタデータキャッシュを強制更新する
          リフレッシュボタン（更新中はアイコンを回転させて進行中であることを示す）。 */}
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="font-mono text-2xs text-ink-subtle">
          {catalogs.data
            ? syntheticCatalog
              ? 'schemas'
              : `${catalogs.data.items.length} catalogs`
            : ' '}
        </span>
        <IconButton
          icon={RefreshCw}
          label="Refresh metadata"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
          className={refresh.isPending ? 'animate-spin' : undefined}
        />
      </div>

      {/* ツリー本体: catalog 一覧の読み込み中/エラー/空/取得済みの各状態を出し分け、
          取得済みなら catalog ごとに CatalogNode を再帰的なツリーのルートとして描画する。 */}
      <div className="py-1">
        {catalogs.isPending && <NodeStatus depth={0} state="loading" />}
        {catalogs.isError && (
          <NodeStatus depth={0} state="error" onRetry={() => void catalogs.refetch()} />
        )}
        {catalogs.data && catalogs.data.items.length === 0 && (
          <NodeStatus depth={0} state="empty" emptyLabel="No catalogs" />
        )}
        {syntheticCatalog ? (
          <CatalogNode
            datasourceId={datasourceId}
            catalog={syntheticCatalog}
            needle={needle}
            context={context}
            expanded
            expandedKeys={effectiveExpanded}
            toggle={toggle}
            onShowDetail={setDetailTarget}
            hideCatalogRow
          />
        ) : (
          (catalogs.data?.items ?? []).map((c) => (
            <CatalogNode
              key={c.name}
              datasourceId={datasourceId}
              catalog={c.name}
              needle={needle}
              context={context}
              expanded={effectiveExpanded.has(c.name)}
              expandedKeys={effectiveExpanded}
              toggle={toggle}
              onShowDetail={setDetailTarget}
            />
          ))
        )}
      </div>

      {/* detailTarget が設定されているとき（情報アイコンがクリックされたとき）だけ
          テーブル詳細ポップオーバーをオーバーレイ表示する。 */}
      {detailTarget && (
        <TableDetailPopover
          target={detailTarget}
          context={context}
          datasourceId={datasourceId}
          onClose={() => setDetailTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * ResultGrid.tsx
 *
 * SQL クエリ結果を表示する高密度な仮想化グリッドコンポーネント。
 * @tanstack/react-virtual を用いて画面に見えている行だけを DOM に描画することで、
 * 大量の行数でも軽快にスクロールできるようにしている。ヘッダー行は固定表示（sticky）、
 * 行番号列を左端に表示し、数値型カラムは右寄せと等幅フォントで表示する。
 * 列の表示/非表示切り替え、フィルタ（部分一致検索）、列ソートといった
 * クライアントサイドの軽量な操作をサポートする。これらの操作は「現在読み込み済みの行」
 * に対してのみ作用し、ストリーミングで追加される行にも継続して適用される。
 */
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryColumn } from '@hubble/contracts';
import { ArrowDown, ArrowUp, Columns3, Search, X } from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { cn } from '../../utils/cn';
import { formatDecimal, formatInt } from '../../utils/format';
import type { ResultRow } from '../../execution';

/**
 * High-density virtualized result grid: fixed header, row-number
 * column, 28px rows, mono numerics, column type labels. Rows stream in (the
 * parent passes a growing array). Client-side sort/filter operate over the rows
 * currently loaded — additional rows keep streaming in underneath. NULL is
 * rendered as a muted `NULL` token so it is visually distinct from empty text.
 */

// 1行あたりの高さ（px）。仮想化の見積もりサイズにもそのまま使う。
const ROW_HEIGHT = 28;
// ヘッダー行の高さ（px）。
const HEADER_HEIGHT = 28;
// 仮想化のオーバースキャン数（画面外にも余分に描画しておく行数）。スクロール時のちらつき防止。
const OVERSCAN = 12;
// カラムの型名から「数値型かどうか」を判定するための正規表現（先頭一致）。
const NUMERIC_TYPES = /^(bigint|integer|int|smallint|tinyint|double|real|decimal|float)/i;
// カラムの型名から「小数を含みうる数値型かどうか」を判定するための正規表現。
const DECIMAL_TYPES = /^(double|real|decimal|float)/i;

/** カラムの型名が数値型（整数、小数含む）かどうかを判定する。 */
function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.test(type);
}

/** セルの描画結果。表示用テキストと、NULL値かどうかのフラグを持つ。 */
interface RenderedValue {
  text: string;
  isNull: boolean;
}

/**
 * セルの生値（value）と列の型（type）から、表示用のテキストと NULL 判定を組み立てる。
 * - null / undefined は "NULL" という専用トークンとして扱う（isNull: true）。
 * - 数値は小数系の型なら formatDecimal、それ以外は formatInt でフォーマットする。
 * - 真偽値は "true"/"false" の文字列に変換する。
 * - オブジェクトは JSON.stringify して表示する。
 * - それ以外は String() で文字列化する。
 */
function renderValue(value: unknown, type: string): RenderedValue {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true };
  if (typeof value === 'number') {
    return {
      text: DECIMAL_TYPES.test(type) ? formatDecimal(value) : formatInt(value),
      isNull: false,
    };
  }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false };
  if (typeof value === 'object') return { text: JSON.stringify(value), isNull: false };
  return { text: String(value), isNull: false };
}

/** Lowercased string projection of a cell, for filtering. */
// フィルタ処理用に、セルの値を小文字化した文字列へ変換する（大文字小文字を無視した部分一致検索のため）。
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value).toLowerCase();
  return String(value).toLowerCase();
}

type SortDir = 'asc' | 'desc';
/** 現在のソート対象カラムのインデックスと昇順/降順の状態。未ソート時は null。 */
interface SortState {
  colIndex: number;
  dir: SortDir;
}

/**
 * 2つのセル値を比較する。NULL は常に先頭に来るようにし（nulls first）、
 * numeric フラグが立っている場合は数値として、それ以外は文字列として
 * localeCompare で比較する。Array.prototype.sort に渡す比較関数として使う。
 */
function compareValues(a: unknown, b: unknown, numeric: boolean): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return -1; // nulls first
  if (bn) return 1;
  if (numeric) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/** ResultGrid コンポーネントの props。 */
interface ResultGridProps {
  /** 表示するカラムのメタ情報（名前、型）の配列。 */
  columns: QueryColumn[];
  /** 現在読み込み済みの結果行。ストリーミングで随時追加されうる。 */
  rows: ReadonlyArray<ResultRow>;
  /** ルート要素に付与する追加の Tailwind クラス。 */
  className?: string;
}

/**
 * クエリ結果を仮想化して表示するグリッドコンポーネント。
 * 列の表示/非表示切り替え、行フィルタ（部分一致、大文字小文字無視）、
 * 列ヘッダークリックによるソート（昇順→降順→解除の3段階トグル）を提供する。
 * 行の実描画は @tanstack/react-virtual に委譲し、スクロール中も
 * 画面内の行だけを DOM 上に生成することでパフォーマンスを確保している。
 */
export function ResultGrid({ columns, rows, className }: ResultGridProps) {
  // 仮想化スクロールコンテナへの参照。useVirtualizer にスクロール要素として渡す。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 非表示にした列のインデックス集合。
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  // 列の表示/非表示を切り替えるドロップダウンメニューの開閉状態。
  const [colMenuOpen, setColMenuOpen] = useState(false);
  // 行フィルタの検索文字列。
  const [filter, setFilter] = useState('');
  // フィルタ入力欄自体の表示/非表示状態（アイコンクリックでトグル）。
  const [showFilter, setShowFilter] = useState(false);
  // 現在のソート状態（対象カラムと方向）。null は未ソート。
  const [sort, setSort] = useState<SortState | null>(null);

  // hidden に含まれない列だけを、元のカラムインデックスとともに抽出する。
  // ヘッダー、各行のセル描画、グリッドテンプレート計算のすべてがこの配列を使う。
  const visibleColumns = useMemo(
    () => columns.map((c, i) => ({ col: c, index: i })).filter(({ index }) => !hidden.has(index)),
    [columns, hidden],
  );

  // Filter (client-side, over loaded rows) then sort (stable, loaded range).
  // 画面に表示する行を組み立てる: まず読み込み済みの行すべてを元のインデックス
  // (sourceIndex、行番号列の表示に使う) 付きで保持し、フィルタ文字列があれば
  // いずれかのセルに部分一致する行だけへ絞り込み、さらにソート指定があれば
  // 安定ソート（同順位のときは元の並び順を保つ）で並べ替える。
  const view = useMemo(() => {
    // 検索語を trim + 小文字化しておき、cellText（小文字化済み）と比較できるようにする。
    const needle = filter.trim().toLowerCase();
    // 全行を { 行データ, 元のインデックス } の形に変換した初期状態。
    let result: { row: ResultRow; sourceIndex: number }[] = rows.map((row, i) => ({
      row,
      sourceIndex: i,
    }));
    if (needle) {
      // フィルタ: いずれかのセルのテキストに検索語が含まれる行のみ残す。
      result = result.filter(({ row }) => row.some((cell) => cellText(cell).includes(needle)));
    }
    if (sort) {
      // ソート対象カラムが数値型かどうかで比較方法を切り替える。
      const numeric = isNumericType(columns[sort.colIndex]?.type ?? '');
      const factor = sort.dir === 'asc' ? 1 : -1;
      result = result
        // 配列インデックス i を保持しておき、比較結果が同値のときのタイブレークに使う（安定ソート）。
        .map((entry, i) => ({ entry, i }))
        .sort((x, y) => {
          const cmp = compareValues(
            x.entry.row[sort.colIndex],
            y.entry.row[sort.colIndex],
            numeric,
          );
          return cmp !== 0 ? cmp * factor : x.i - y.i; // stable
        })
        .map(({ entry }) => entry);
    }
    return result;
  }, [rows, filter, sort, columns]);

  // TanStack Virtual returns fresh function identities each render; the React
  // Compiler rule flags it as un-memoizable. That is expected and harmless here
  // (we don't pass the virtualizer's functions into memoized children).
  // eslint-disable-next-line react-hooks/incompatible-library
  // 仮想化の本体。表示対象の行数（view.length）、スクロール要素の取得方法、
  // 行の見積もり高さ、オーバースキャン数を渡して初期化する。
  const rowVirtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  // 列の表示/非表示をトグルするハンドラー。hidden セットに index があれば削除（表示に戻す）、
  // なければ追加（非表示にする）。
  const toggleColumn = (index: number) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // 列ヘッダークリック時のソート状態トグル。
  // 別の列 or 未ソートの状態から押すと昇順(asc)に、
  // 同じ列で asc の状態から押すと降順(desc)に、
  // 同じ列で desc の状態から押すと未ソート(null)に戻る、という3段階サイクル。
  const toggleSort = (colIndex: number) => {
    setSort((prev) => {
      if (!prev || prev.colIndex !== colIndex) return { colIndex, dir: 'asc' };
      if (prev.dir === 'asc') return { colIndex, dir: 'desc' };
      return null; // third click clears
    });
  };

  // Grid template: row-number column + one column per visible field.
  // CSS Grid の grid-template-columns 文字列を組み立てる。先頭は行番号列固定幅、
  // 以降は表示中の列ごとに、数値型なら少し狭め、文字列型なら少し広めの minmax を割り当てる。
  const gridTemplate = `3.25rem ${visibleColumns
    .map(({ col }) =>
      isNumericType(col.type) ? 'minmax(7rem, max-content)' : 'minmax(9rem, max-content)',
    )
    .join(' ')}`;

  // 現在ビューポート内にある（描画すべき）仮想行の一覧。
  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Grid toolbar: column menu + filter. */}
      {/* グリッド上部のツールバー: 列の表示/非表示メニューと行フィルタ入力欄、読み込み済み行数表示。 */}
      <div className="flex items-center gap-1 border-b border-border-subtle bg-surface-base px-2 py-1">
        <div className="relative">
          {/* 列メニューを開くトグルボタン。非表示列が1つでもあればアクティブ表示にする。 */}
          <IconButton
            icon={Columns3}
            label="Show / hide columns"
            size="sm"
            active={hidden.size > 0}
            onClick={() => setColMenuOpen((o) => !o)}
          />
          {/* 列の表示/非表示を切り替えるドロップダウンメニュー（開いているときだけ描画）。 */}
          {colMenuOpen && (
            <ColumnMenu
              columns={columns}
              hidden={hidden}
              onToggle={toggleColumn}
              onClose={() => setColMenuOpen(false)}
            />
          )}
        </div>
        {/* フィルタ入力欄の表示/非表示を切り替えるトグルボタン。入力中や検索語がある場合はアクティブ表示。 */}
        <IconButton
          icon={Search}
          label="Filter rows"
          size="sm"
          active={showFilter || filter.length > 0}
          onClick={() => setShowFilter((s) => !s)}
        />
        {/* フィルタ入力欄本体（showFilter が true のときだけ表示）。 */}
        {showFilter && (
          <div className="relative flex-1">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter loaded rows…"
              aria-label="Filter rows"
              className={cn(
                'h-6 w-full rounded-sm border border-border-base bg-surface-raised px-2 pr-6',
                'font-mono text-2xs text-ink-base placeholder:text-ink-subtle',
                'focus-visible:border-accent focus-visible:outline-none',
              )}
            />
            {/* 検索語が入力されているときだけ表示するクリアボタン。 */}
            {filter && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setFilter('')}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-ink-subtle hover:text-ink-strong"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        {/* 右端に読み込み済み行数（フィルタ適用時は絞り込み後件数も）を表示する。 */}
        <span className="ml-auto font-mono text-2xs text-ink-subtle tabular-nums">
          {filter ? `${formatInt(view.length)} / ` : ''}
          {formatInt(rows.length)} loaded
        </span>
      </div>

      {/* Virtualized scroll body with a sticky CSS-grid header. */}
      {/* 仮想化されたスクロール本体。ヘッダー行は sticky で常に上部に固定表示される。 */}
      <div
        ref={scrollRef}
        className="max-h-96 min-h-[8rem] overflow-auto bg-surface-sunken"
        data-testid="result-grid"
      >
        <div style={{ width: 'max-content', minWidth: '100%' }}>
          {/* Header row */}
          {/* ヘッダー行: 行番号列見出し「#」+ 表示中の各カラムのソート可能なボタン。 */}
          <div
            className="sticky top-0 z-10 grid bg-surface-inset"
            style={{ gridTemplateColumns: gridTemplate, height: HEADER_HEIGHT }}
          >
            <div className="flex items-center justify-end border-r border-b border-border-base px-2 font-mono text-2xs text-ink-subtle">
              #
            </div>
            {/* 表示中の各カラムについて、名前、型、ソートアイコンを含むヘッダーセルを描画する。 */}
            {visibleColumns.map(({ col, index }) => {
              const numeric = isNumericType(col.type);
              const sorted = sort?.colIndex === index ? sort.dir : undefined;
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => toggleSort(index)}
                  title={`${col.name} (${col.type}) — click to sort`}
                  className={cn(
                    'flex items-center gap-1.5 border-r border-b border-border-base px-3',
                    'text-2xs font-semibold tracking-wider text-ink-muted uppercase',
                    'hover:bg-surface-raised',
                    numeric ? 'justify-end text-right' : 'justify-start text-left',
                  )}
                >
                  {numeric && <SortIcon dir={sorted} />}
                  <span className="truncate normal-case">{col.name}</span>
                  <span className="font-mono text-[0.625rem] font-normal tracking-normal text-ink-subtle normal-case">
                    {col.type}
                  </span>
                  {!numeric && <SortIcon dir={sorted} />}
                </button>
              );
            })}
          </div>

          {/* Virtual rows */}
          {/* 仮想行の描画領域。全体の高さを getTotalSize() で確保しつつ、
              実際に DOM へ描画するのは virtualRows（画面内 + オーバースキャン分）のみ。 */}
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {virtualRows.map((vRow) => {
              // 表示すべき行データ（フィルタとソート適用済みの view から、仮想化インデックスで取得）。
              const entry = view[vRow.index]!;
              return (
                <div
                  key={vRow.key}
                  className="group absolute grid hover:bg-surface-raised"
                  style={{
                    gridTemplateColumns: gridTemplate,
                    height: ROW_HEIGHT,
                    // translateY で仮想スクロール位置に配置する（絶対配置 + transform方式）。
                    transform: `translateY(${vRow.start}px)`,
                    top: 0,
                    left: 0,
                    width: '100%',
                  }}
                >
                  {/* 行番号セル（元データ上の1始まりインデックス）。 */}
                  <div className="flex items-center justify-end border-r border-b border-border-subtle bg-surface-inset px-2 font-mono text-2xs text-ink-subtle select-none group-hover:bg-accent-soft">
                    {entry.sourceIndex + 1}
                  </div>
                  {/* 表示中の各カラムについて、renderValue でフォーマットしたセル値を描画する。 */}
                  {visibleColumns.map(({ col, index }) => {
                    const numeric = isNumericType(col.type);
                    const rendered = renderValue(entry.row[index], col.type);
                    return (
                      <div
                        key={index}
                        className={cn(
                          'flex items-center overflow-hidden border-r border-b border-border-subtle px-3',
                          'whitespace-nowrap',
                          numeric
                            ? 'justify-end font-mono text-xs tabular-nums text-ink-base'
                            : 'font-mono text-xs text-ink-base',
                          rendered.isNull && 'text-ink-subtle italic',
                        )}
                        title={rendered.text}
                      >
                        {/* pr-px: the italic NULL's final glyph leans past its
                            advance width; without it `truncate` clips the ink. */}
                        <span className={cn('truncate', rendered.isNull && 'pr-px')}>
                          {rendered.text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** ソート方向を示す小さな矢印アイコン。未ソート（dir が undefined）のときは何も描画しない。 */
function SortIcon({ dir }: { dir?: SortDir }) {
  if (!dir) return null;
  const Icon = dir === 'asc' ? ArrowUp : ArrowDown;
  return <Icon size={11} strokeWidth={2.25} className="shrink-0 text-accent" />;
}

/** ColumnMenu コンポーネントの props。 */
interface ColumnMenuProps {
  /** 全カラムのメタ情報。 */
  columns: QueryColumn[];
  /** 現在非表示になっているカラムのインデックス集合。 */
  hidden: ReadonlySet<number>;
  /** カラムの表示/非表示をトグルするコールバック。 */
  onToggle: (index: number) => void;
  /** メニューを閉じるコールバック（背景クリック時に呼ばれる）。 */
  onClose: () => void;
}

/**
 * 列の表示/非表示を切り替えるドロップダウンメニュー。
 * カラム名で絞り込み検索でき、各行のチェックボックスで個別に表示/非表示を切り替えられる。
 * 背景（バックドロップ）をクリックすると onClose が呼ばれて閉じる。
 */
function ColumnMenu({ columns, hidden, onToggle, onClose }: ColumnMenuProps) {
  // メニュー内のカラム名検索クエリ。
  const [search, setSearch] = useState('');
  // 検索クエリに部分一致するカラムだけを、元のインデックス付きで抽出する。
  const filtered = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      {/* Click-away backdrop. */}
      {/* 画面全体を覆う透明な背景。ここをクリックするとメニューが閉じる（click-away）。 */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div className="absolute top-7 left-0 z-40 w-60 rounded-md border border-border-base bg-surface-overlay p-1.5 shadow-lg">
        {/* カラム名の検索入力欄。 */}
        <div className="mb-1.5 flex items-center gap-1.5 rounded-sm border border-border-base bg-surface-raised px-2">
          <Search size={12} strokeWidth={2} className="text-ink-subtle" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search columns…"
            aria-label="Search columns"
            className="h-6 flex-1 bg-transparent text-xs text-ink-base placeholder:text-ink-subtle focus:outline-none"
          />
        </div>
        {/* 検索結果に一致するカラムの一覧。各行はチェックボックス付きラベルで、
            チェックを外すと該当カラムが非表示になる。 */}
        <div className="max-h-56 overflow-auto">
          {filtered.map(({ c, i }) => (
            <label
              key={i}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                checked={!hidden.has(i)}
                onChange={() => onToggle(i)}
                className="accent-accent"
              />
              <span className="truncate text-xs text-ink-base">{c.name}</span>
              <span className="ml-auto font-mono text-[0.625rem] text-ink-subtle">{c.type}</span>
            </label>
          ))}
          {/* 検索条件に一致するカラムが1つもない場合のメッセージ。 */}
          {filtered.length === 0 && (
            <p className="px-2 py-2 text-2xs text-ink-subtle">No matching columns.</p>
          )}
        </div>
      </div>
    </>
  );
}

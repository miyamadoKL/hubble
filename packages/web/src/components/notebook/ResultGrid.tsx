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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryColumn } from '@hubble/contracts';
import { ArrowDown, ArrowUp, Columns3, Search, Sigma, X } from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { cn } from '../../utils/cn';
import { formatDecimal, formatInt } from '../../utils/format';
import type { ResultRow } from '../../execution';
import { ColumnProfilePanel } from './ColumnProfilePanel';
import { useServerResultView } from './useServerResultView';
import { VerticalResizeHandle } from '../common/VerticalResizeHandle';
import {
  RESULT_HEIGHT_MIN,
  beginResultHeightResize,
  clampResultHeight,
  getResultHeight,
  resetResultHeight,
  resultHeightMax,
  setResultHeight,
} from '../../notebook/resultHeight';
import { useT } from '../../i18n/t';
import { notebookMessages } from '../../i18n/messages/notebook';

// @tanstack/react-table への置換は見送っている。2026 年 7 月 18 日の read-only preflight
// （@tanstack/react-virtual は維持する前提）で計測したところ、本ファイルは 598 物理行/443
// 実装行で、filter / sort / source projection のヘルパー（cellText、buildClientViewIndices、
// materializeClientRow、compareValues）が 93 物理行/75 実装行、state と view の配線が 98
// 物理行/53 実装行だった。TanStack へ移せるのはこの合計 148 実装行のうち UI と server
// boundary を除いた部分に限られる一方、現行契約（column 定義と index 対応、custom global
// filter、null/numeric/string 比較と安定 sort、server-side 時の manual filtering/sorting、
// source row index の維持、streaming 時の row model 更新、virtual row からの visible cell
// 取得、ColumnMenu の検索/click-away 接続）を保つ adapter に保守的に見積もっても 70〜100
// 実装行を要し、削減分を大きく相殺する。依存追加前の production 正味削減上限は 20〜50
// 実装行で 75 行の採用基準（gate）に届かないため、characterization test、依存追加、PoC は
// 行わず、自前の sort / filter 実装を維持している。

// 1行あたりの高さ（px）。仮想化の見積もりサイズにもそのまま使う。
const ROW_HEIGHT = 28;
// ヘッダー行の高さ（px）。
const HEADER_HEIGHT = 28;
// 仮想化のオーバースキャン数（画面外にも余分に描画しておく行数）。スクロール時のちらつき防止。
const OVERSCAN = 12;
// 列幅の見積もりでスキャンする行数の上限（全行スキャンは大量結果で無駄なため）。
const WIDTH_SAMPLE_ROWS = 1000;
// セル本文 (text-xs の等幅フォント) のおおよその 1 文字幅（px）。
const CELL_CH_PX = 7.3;
// ヘッダーのカラム名 (text-2xs、uppercase + tracking) のおおよその 1 文字幅（px）。
const HEADER_NAME_CH_PX = 7;
// ヘッダーの型ラベル (0.625rem の等幅フォント) のおおよその 1 文字幅（px）。
const HEADER_TYPE_CH_PX = 6.5;
// セルの左右 padding (px-3 = 24px) とボーダー分。
const CELL_PADDING_PX = 26;
// ヘッダーの padding、名前と型ラベルの間の gap、ソートアイコンの合計余白。
const HEADER_EXTRA_PX = 46;
// 列幅の下限と上限（px）。上限を超える長文は truncate + title 表示に任せる。
const MIN_COL_PX = 80;
const MAX_COL_PX = 480;
// 行番号列の幅（px）。3.25rem 相当。
const ROW_NUMBER_COL_PX = 52;
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

// フィルタ処理用に、セルの値を小文字化した文字列へ変換する（大文字小文字を無視した部分一致検索のため）。
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value).toLowerCase();
  return String(value).toLowerCase();
}

type SortDir = 'asc' | 'desc';
/** 現在のソート対象カラムのインデックスと昇順/降順の状態。未ソート時は null。 */
export interface SortState {
  colIndex: number;
  dir: SortDir;
}

/** filterまたはsortが有効な場合だけ、表示順のsource indexを構築する。 */
export function buildClientViewIndices(
  rows: ReadonlyArray<ResultRow>,
  columns: ReadonlyArray<QueryColumn>,
  filter: string,
  sort: SortState | null,
): number[] | null {
  const needle = filter.trim().toLowerCase();
  if (!needle && !sort) return null;
  let indices = Array.from({ length: rows.length }, (_, index) => index);
  if (needle) {
    indices = indices.filter((index) =>
      rows[index]!.some((cell) => cellText(cell).includes(needle)),
    );
  }
  if (sort) {
    const numeric = isNumericType(columns[sort.colIndex]?.type ?? '');
    const factor = sort.dir === 'asc' ? 1 : -1;
    indices.sort((left, right) => {
      const cmp = compareValues(rows[left]![sort.colIndex], rows[right]![sort.colIndex], numeric);
      return cmp !== 0 ? cmp * factor : left - right;
    });
  }
  return indices;
}

/** 仮想行1件だけを表示用の行とsource indexへ変換する。 */
export function materializeClientRow(
  rows: ReadonlyArray<ResultRow>,
  viewIndices: ReadonlyArray<number> | null,
  viewIndex: number,
): { row: ResultRow; sourceIndex: number } {
  const sourceIndex = viewIndices?.[viewIndex] ?? viewIndex;
  return { row: rows[sourceIndex]!, sourceIndex };
}

/** 先頭サンプルが確定した後は、行versionが進んでも列幅計測を再開しない。 */
export function columnWidthChangeKey(
  rows: ReadonlyArray<ResultRow>,
  rowsVersion: number | undefined,
): ReadonlyArray<ResultRow> | number {
  if (rowsVersion === undefined) return rows;
  return rows.length < WIDTH_SAMPLE_ROWS ? rowsVersion : WIDTH_SAMPLE_ROWS;
}

/** ヘッダーと先頭サンプルから、表示列の固定幅を計算する。 */
export function calculateColumnWidths(
  rows: ReadonlyArray<ResultRow>,
  visibleColumns: ReadonlyArray<{ col: QueryColumn; index: number }>,
): number[] {
  const sampleCount = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
  return visibleColumns.map(({ col, index }) => {
    const headerPx =
      col.name.length * HEADER_NAME_CH_PX + col.type.length * HEADER_TYPE_CH_PX + HEADER_EXTRA_PX;
    let maxChars = 0;
    for (let rowIndex = 0; rowIndex < sampleCount; rowIndex++) {
      const len = renderValue(rows[rowIndex]![index], col.type).text.length;
      if (len > maxChars) maxChars = len;
    }
    const cellPx = maxChars * CELL_CH_PX + CELL_PADDING_PX;
    return Math.round(Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, headerPx, cellPx)));
  });
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
  if (an) return -1; // NULL を先頭にする
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
  /** in-placeの行更新を検知する単調増加version。 */
  rowsVersion?: number;
  /**
   * 対象クエリ id。指定すると列プロファイル表示が有効になり、
   * さらに全行が未ロードの完了済み結果では filter / sort がサーバー側で実行される。
   */
  queryId?: string;
  /** サーバーが保持する総行数（rows.length を上回りうる）。 */
  totalRows?: number;
  /** クエリが終了しており、以降行が増えないことを示す。 */
  complete?: boolean;
  /** ルート要素に付与する追加の Tailwind クラス。 */
  className?: string;
  /** 結果表示域の高さ調整を永続化するためのノートブックID。省略時は高さ調整を無効化する。 */
  notebookId?: string;
  /** 結果表示域の高さ調整を永続化するためのセルID。省略時は高さ調整を無効化する。 */
  cellId?: string;
}

/**
 * クエリ結果を仮想化して表示するグリッドコンポーネント。
 * 列の表示/非表示切り替え、行フィルタ（部分一致、大文字小文字無視）、
 * 列ヘッダークリックによるソート（昇順→降順→解除の3段階トグル）を提供する。
 * 行の実描画は @tanstack/react-virtual に委譲し、スクロール中も
 * 画面内の行だけを DOM 上に生成することでパフォーマンスを確保している。
 */
export function ResultGrid({
  columns,
  rows,
  rowsVersion,
  queryId,
  totalRows,
  complete,
  className,
  notebookId,
  cellId,
}: ResultGridProps) {
  const t = useT(notebookMessages);
  // 仮想化スクロールコンテナへの参照。useVirtualizer にスクロール要素として渡す。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 明示的に調整された高さ（px）。null なら未調整で、内容に応じて伸びつつ
  // Tailwind の max-h-96（384px）を上限にする従来どおりの挙動になる。
  // 初期値は localStorage から一度だけ読み出す（notebookId/cellId 未指定時は常に null）。
  // 保存後にビューポートが縮んだ、または他のクライアントが異なる上限で保存した等で
  // 生の保存値が現在の許容範囲外になっている場合があるため、読み出し側（列幅側の
  // NotebookView と同じ設計）でマウント時点のビューポート高さに応じてクランプする。
  const [customHeight, setCustomHeight] = useState<number | null>(() => {
    if (!notebookId || !cellId) return null;
    const stored = getResultHeight(notebookId, cellId);
    if (stored === null) return null;
    return clampResultHeight(stored, typeof window !== 'undefined' ? window.innerHeight : stored);
  });
  // 高さドラッグ中の pointer リスナー解除関数。ドラッグ中でなければ null。
  const heightDragCleanupRef = useRef<(() => void) | null>(null);
  // unmount 時にドラッグ中のリスナーが残らないようにする。
  useEffect(() => () => heightDragCleanupRef.current?.(), []);
  // 未調整時（customHeight === null）のスクロールコンテナの実測高さ。ResizeObserver で
  // 追跡し、aria-valuenow とキーボード操作の基準値に使う。ResizeObserver が使えない環境
  // （jsdom 等）やまだ計測前は null にしておき、呼び出し側で下限（RESULT_HEIGHT_MIN）へ
  // フォールバックさせる。
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  // customHeight が null（未調整）の間だけ ResizeObserver を張り、調整済みへ遷移したら
  // 解除する。unmount 時にも確実に disconnect する。
  useEffect(() => {
    if (customHeight !== null) return;
    if (typeof ResizeObserver === 'undefined') return;
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height !== undefined) setMeasuredHeight(height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [customHeight]);
  // 非表示にした列のインデックス集合。
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  // 列の表示/非表示を切り替えるドロップダウンメニューの開閉状態。
  const [colMenuOpen, setColMenuOpen] = useState(false);
  // 列プロファイルパネルの開閉状態。
  const [profileOpen, setProfileOpen] = useState(false);
  // 行フィルタの検索文字列。
  const [filter, setFilter] = useState('');
  // フィルタ入力欄自体の表示/非表示状態（アイコンクリックでトグル）。
  const [showFilter, setShowFilter] = useState(false);
  // 現在のソート状態（対象カラムと方向）。null は未ソート。
  const [sort, setSort] = useState<SortState | null>(null);

  // server-side モード: クライアントに全行が載っていない完了済み結果
  // （履歴から開いた永続化結果など）では、filter / sort をサーバー側で実行する。
  // ストリーミング中（complete でない）は従来どおりクライアント側で処理する。
  const serverCapable =
    queryId !== undefined && complete === true && (totalRows ?? rows.length) > rows.length;
  const serverActive = serverCapable && (filter.trim() !== '' || sort !== null);
  const serverView = useServerResultView(
    queryId,
    serverActive,
    filter,
    sort !== null ? { columnIndex: sort.colIndex, dir: sort.dir } : null,
  );

  // hidden に含まれない列だけを、元のカラムインデックスとともに抽出する。
  // ヘッダー、各行のセル描画、グリッドテンプレート計算のすべてがこの配列を使う。
  const visibleColumns = useMemo(
    () => columns.map((c, i) => ({ col: c, index: i })).filter(({ index }) => !hidden.has(index)),
    [columns, hidden],
  );

  // 画面に表示する行を組み立てる: まず読み込み済みの行すべてを元のインデックス
  // (sourceIndex、行番号列の表示に使う) 付きで保持し、フィルタ文字列があれば
  // いずれかのセルに部分一致する行だけへ絞り込み、さらにソート指定があれば
  // 安定ソート（同順位のときは元の並び順を保つ）で並べ替える。
  const rowChangeKey = rowsVersion ?? rows;
  const viewIndices = useMemo(() => {
    void rowChangeKey;
    return serverActive ? null : buildClientViewIndices(rows, columns, filter, sort);
  }, [rows, columns, filter, sort, serverActive, rowChangeKey]);
  const viewLength = serverActive ? serverView.rows.length : (viewIndices?.length ?? rows.length);

  // TanStack Virtual はレンダーのたびに新しい関数参照を返すため、React Compiler の
  // ルールはこれを「メモ化不可能」として検知する。ここでは仮想化の関数をメモ化された
  // 子コンポーネントへ渡していないため実害はなく、意図的にこの警告を無効化している。
  // eslint-disable-next-line react-hooks/incompatible-library
  // 仮想化の本体。表示対象の行数（view.length）、スクロール要素の取得方法、
  // 行の見積もり高さ、オーバースキャン数を渡して初期化する。
  const rowVirtualizer = useVirtualizer({
    count: viewLength,
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
      return null; // 3 回目のクリックで未ソートへ戻す
    });
  };

  // 高さを変更し、ノートブックID/セルIDが揃っていれば localStorage へ永続化する。
  // height が null なら「未調整」へ戻す（明示的な高さの解除）。
  const applyHeight = (height: number | null) => {
    const clamped = height === null ? null : clampResultHeight(height, window.innerHeight);
    setCustomHeight(clamped);
    if (!notebookId || !cellId) return;
    if (clamped === null) resetResultHeight(notebookId, cellId);
    else setResultHeight(notebookId, cellId, clamped);
  };

  // 高さリサイズハンドルの pointerdown で呼ばれる。ドラッグ開始時の高さは、
  // 未調整であれば現在の実測高さ（内容依存の可変値）から連続的に変化させる。
  // ドラッグ開始時の pointerId を beginResultHeightResize に渡し、無関係な
  // ポインタ（マルチタッチ等）からの pointermove/pointerup/pointercancel を無視させる。
  const startHeightDrag = (e: React.PointerEvent) => {
    heightDragCleanupRef.current?.();
    const startHeight =
      customHeight ?? scrollRef.current?.getBoundingClientRect().height ?? RESULT_HEIGHT_MIN;
    const cleanup = beginResultHeightResize(
      e.clientY,
      startHeight,
      applyHeight,
      () => {
        if (heightDragCleanupRef.current === cleanup) heightDragCleanupRef.current = null;
      },
      e.pointerId,
    );
    heightDragCleanupRef.current = cleanup;
  };

  // グリッドテンプレート（行番号列 + 表示中の各フィールドの列）。
  // CSS Grid の grid-template-columns 文字列を組み立てる。
  // ヘッダーと各仮想行はそれぞれ独立した grid コンテナなので、`max-content` のような
  // コンテンツ依存の幅を使うとコンテナごとに解決結果が異なり、ヘッダーと値の列位置が
  // ずれてしまう。そこで、ヘッダー文字列と読み込み済み行（先頭 WIDTH_SAMPLE_ROWS 件）の
  // 表示テキスト長から列ごとの固定幅（px）を見積もり、全コンテナで同一のテンプレートを使う。
  const widthChangeKey = columnWidthChangeKey(rows, rowsVersion);
  const columnWidths = useMemo(() => {
    void widthChangeKey;
    return calculateColumnWidths(rows, visibleColumns);
  }, [visibleColumns, rows, widthChangeKey]);
  // すべて固定幅（px）のトラックにすることで、どの grid コンテナでも
  // テンプレートの解決結果が同一になり、列位置のずれと余計な横スクロールを防ぐ。
  // (1fr や max-content は intrinsic 幅の算出がコンテナごとのコンテンツに
  // 依存するため使わない。)
  const gridTemplate = `${ROW_NUMBER_COL_PX}px ${columnWidths.map((w) => `${w}px`).join(' ')}`;

  // 現在ビューポート内にある（描画すべき）仮想行の一覧。
  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className={cn('flex flex-col', className)}>
      {/* グリッド上部のツールバー: 列の表示/非表示メニューと行フィルタ入力欄、読み込み済み行数表示。 */}
      <div className="flex items-center gap-1 border-b border-border-subtle bg-surface-base px-2 py-1">
        <div className="relative">
          {/* 列メニューを開くトグルボタン。非表示列が1つでもあればアクティブ表示にする。 */}
          <IconButton
            icon={Columns3}
            label={t('showHideColumns')}
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
        {/* 列プロファイルパネルを開くトグルボタン（queryId があるときのみ表示）。 */}
        {queryId !== undefined && (
          <div className="relative">
            <IconButton
              icon={Sigma}
              label={t('columnStats')}
              size="sm"
              active={profileOpen}
              onClick={() => setProfileOpen((o) => !o)}
            />
            {profileOpen && (
              <ColumnProfilePanel queryId={queryId} onClose={() => setProfileOpen(false)} />
            )}
          </div>
        )}
        {/* フィルタ入力欄の表示/非表示を切り替えるトグルボタン。入力中や検索語がある場合はアクティブ表示。 */}
        <IconButton
          icon={Search}
          label={t('filterRowsAria')}
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
              // server-side モードでは未ロード分も含む全行が対象になる。
              placeholder={
                serverCapable
                  ? t('filterAllRowsServerPlaceholder')
                  : t('filterLoadedRowsPlaceholder')
              }
              aria-label={t('filterRowsAria')}
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
                aria-label={t('clearFilterAria')}
                onClick={() => setFilter('')}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-ink-subtle hover:text-ink-strong"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        {/* 右端に行数を表示する。server-side モードでは全行に対する
            マッチ件数（1 ページに収まらないときは先頭 N 件表示であることを明示）、
            それ以外は読み込み済み行数（フィルタ適用時は絞り込み後件数も）。 */}
        <span className="ml-auto font-mono text-2xs text-ink-subtle tabular-nums">
          {serverActive
            ? serverView.loading
              ? t('searchingEllipsis')
              : (serverView.error ??
                (serverView.totalMatched > serverView.rows.length
                  ? t('firstNOfMMatchedServer', {
                      first: formatInt(serverView.rows.length),
                      total: formatInt(serverView.totalMatched),
                    })
                  : t('nMatchedServer', { total: formatInt(serverView.totalMatched) })))
            : filter
              ? t('filteredLoadedCount', {
                  filtered: formatInt(viewLength),
                  total: formatInt(rows.length),
                })
              : t('loadedCount', { n: formatInt(rows.length) })}
        </span>
      </div>

      {/* 仮想化されたスクロール本体。ヘッダー行は sticky で常に上部に固定表示される。
          明示的に高さを調整済み（customHeight !== null）の場合は実際の height を
          インラインスタイルで固定する。max-height ではなく height を使うのは、行数が
          少ない結果でもユーザーが指定した表示域の高さをそのまま確保するため
          （max-height だと内容が少ないときドラッグが見た目に反映されない）。
          未調整のときは従来どおり Tailwind の max-h-96 / min-h-[8rem] にフォールバックする。 */}
      <div
        ref={scrollRef}
        className={cn(
          'overflow-auto bg-surface-sunken',
          customHeight === null && 'max-h-96 min-h-[8rem]',
        )}
        style={customHeight !== null ? { height: `${customHeight}px` } : undefined}
        data-testid="result-grid"
      >
        <div style={{ width: 'max-content', minWidth: '100%' }}>
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
                  title={t('columnSortTitle', { name: col.name, type: col.type })}
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

          {/* 仮想行の描画領域。全体の高さを getTotalSize() で確保しつつ、
              実際に DOM へ描画するのは virtualRows（画面内 + オーバースキャン分）のみ。 */}
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {virtualRows.map((vRow) => {
              // 表示すべき行データ（フィルタとソート適用済みの view から、仮想化インデックスで取得）。
              const entry = serverActive
                ? { row: serverView.rows[vRow.index]!, sourceIndex: vRow.index }
                : materializeClientRow(rows, viewIndices, vRow.index);
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
                        {/* pr-px: 斜体の NULL 表示は最後の文字がグリフの進行幅をわずかに超えるため、
                            この右パディングが無いと `truncate` がインク部分を欠けさせてしまう。 */}
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

      {/* 結果表示域の高さ調整ハンドル。スクロールコンテナ下端の常時視認できるグリップバー。
          ドラッグ、ダブルクリックでのリセット（未調整状態に戻す）、フォーカス時の
          上下矢印キー（16px刻み）による調整に対応する。 */}
      <VerticalResizeHandle
        ariaLabel={t('resultHeightAria')}
        // 未調整状態（customHeight === null）では、内容量に応じて128〜384pxの間で
        // 変動する実際の表示高さ（measuredHeight、ResizeObserver で追跡）を通知する。
        // 計測前やResizeObserver非対応環境では下限（RESULT_HEIGHT_MIN）にフォールバックする。
        valueNow={customHeight ?? measuredHeight ?? RESULT_HEIGHT_MIN}
        valueMin={RESULT_HEIGHT_MIN}
        valueMax={resultHeightMax(typeof window !== 'undefined' ? window.innerHeight : 0)}
        onPointerDown={startHeightDrag}
        onDoubleClick={() => applyHeight(null)}
        onAdjust={(delta) => {
          // pointerドラッグ側（startHeightDrag）と同じ基準（未調整時は実測高さ）に揃える。
          const current = customHeight ?? measuredHeight ?? RESULT_HEIGHT_MIN;
          applyHeight(current + delta);
        }}
      />
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
  const t = useT(notebookMessages);
  // メニュー内のカラム名検索クエリ。
  const [search, setSearch] = useState('');
  // 検索クエリに部分一致するカラムだけを、元のインデックス付きで抽出する。
  const filtered = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
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
            placeholder={t('searchColumnsPlaceholder')}
            aria-label={t('searchColumnsAria')}
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
            <p className="px-2 py-2 text-2xs text-ink-subtle">{t('noMatchingColumns')}</p>
          )}
        </div>
      </div>
    </>
  );
}

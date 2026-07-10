/**
 * クエリ結果の server-side 探索（filter / sort / search / column profile）の純関数。
 *
 * web の ResultGrid と同じセマンティクスで行を絞り込み、ソートし、列統計を計算する。
 * HTTP 層は行ソース解決と認可のみ担当し、評価ロジックはここに集約する。
 *
 * 行ソースは AsyncIterable（永続化結果の gzip JSONL ストリーム）と同期 Iterable
 * （メモリバッファの配列）の両方を受ける。永続化結果は QUERY_MAX_ROWS で有界では
 * ない（キャプチャはメモリ側の打ち切りと独立に全結果を保存する）ため、全行を
 * 配列へ materialize せず 1 パスの逐次処理で評価し、保持する状態を有界に保つ。
 */
import type { QueryColumn } from '@hubble/contracts';
import {
  RESULT_PROFILE_TOP_VALUES,
  type ResultColumnProfile,
  type ResultFilterCondition,
  type ResultFilterOp,
  type ResultSearchRequest,
} from '@hubble/contracts';

/** searchRowsStream が受け付ける行ソース。同期配列と非同期ストリームの両対応。 */
export type RowSource = Iterable<unknown[]> | AsyncIterable<unknown[]>;

/**
 * search の offset + limit の上限。
 *
 * sort ありの検索は「マッチ順位 offset + limit 件まで」を保持する有界選択で
 * 実装しており、保持行数はこの値が上限になる。契約上 offset に上限がないため、
 * ここで上限を設けないと offset を巨大にするだけで保持行数が無制限に増え、
 * ストリーミング評価にした意味がなくなる。QUERY_MAX_ROWS の既定値と同じ
 * 100,000 行を上限とする。
 */
export const RESULT_SEARCH_MAX_WINDOW = 100_000;

/** 数値型列の判定に使う型名の正規表現（ResultGrid と同一）。 */
const NUMERIC_TYPES = /^(bigint|integer|int|smallint|tinyint|double|real|decimal|float)/i;

/** distinct 追跡の上限。超過後は既出値のみカウントを継続する。 */
const DISTINCT_TRACK_LIMIT = 10_000;

/** プロファイル表示および distinct key 用の文字列最大長。 */
const VALUE_TEXT_MAX_LEN = 100;

/**
 * 列型が数値型かどうかを判定する。
 * @param type - 列型名。
 */
function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.test(type);
}

/**
 * セル値が NULL 相当かどうかを判定する。
 * @param value - セル値。
 */
function isNullCell(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * 検索・contains 用の文字列射影（小文字化済み）。
 * null/undefined は空文字、object は JSON.stringify、それ以外は String()。
 * @param value - セル値。
 */
function cellTextLower(value: unknown): string {
  if (isNullCell(value)) return '';
  if (typeof value === 'object') return JSON.stringify(value).toLowerCase();
  return String(value).toLowerCase();
}

/**
 * プロファイル用の文字列射影（小文字化しない）。
 * @param value - セル値。
 */
function cellTextRaw(value: unknown): string {
  if (isNullCell(value)) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 表示および distinct key 用に文字列を切り詰める。
 * @param text - 元の文字列。
 */
function truncateValueText(text: string): string {
  return text.length > VALUE_TEXT_MAX_LEN ? text.slice(0, VALUE_TEXT_MAX_LEN) : text;
}

/**
 * 数値比較用にセル値を数値へ変換する。NULL または NaN のとき undefined。
 * @param cell - セル値。
 */
function numericComparable(cell: unknown): number | undefined {
  if (isNullCell(cell)) return undefined;
  const n = Number(cell);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * ResultGrid の compareValues と同じ比較。NULL は常に先頭（nulls first）。
 * @param a - 左辺のセル値。
 * @param b - 右辺のセル値。
 * @param numeric - 数値型列として比較するか。
 */
function compareValues(a: unknown, b: unknown, numeric: boolean): number {
  const an = isNullCell(a);
  const bn = isNullCell(b);
  if (an && bn) return 0;
  if (an) return -1;
  if (bn) return 1;
  if (numeric) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/**
 * 1 つのフィルタ条件がセルにマッチするかを判定する。
 * @param cell - セル値。
 * @param columnType - 列型名。
 * @param op - 比較演算子。
 * @param filterValue - 比較値（isNull/notNull では未使用）。
 */
function matchesFilter(
  cell: unknown,
  columnType: string,
  op: ResultFilterOp,
  filterValue?: string,
): boolean {
  if (op === 'contains') {
    const needle = (filterValue ?? '').toLowerCase();
    return cellTextLower(cell).includes(needle);
  }
  if (op === 'isNull') return isNullCell(cell);
  if (op === 'notNull') return !isNullCell(cell);

  const numeric = isNumericType(columnType);
  if (numeric) {
    const cn = numericComparable(cell);
    const vn = filterValue !== undefined ? Number(filterValue) : Number.NaN;
    if (cn === undefined || Number.isNaN(vn)) {
      if (op === 'neq') return !isNullCell(cell);
      return false;
    }
    switch (op) {
      case 'eq':
        return cn === vn;
      case 'neq':
        return cn !== vn;
      case 'gt':
        return cn > vn;
      case 'gte':
        return cn >= vn;
      case 'lt':
        return cn < vn;
      case 'lte':
        return cn <= vn;
      default:
        return false;
    }
  }

  if (isNullCell(cell)) {
    if (op === 'neq') return false;
    return false;
  }
  const cs = String(cell);
  const fv = filterValue ?? '';
  switch (op) {
    case 'eq':
      return cs === fv;
    case 'neq':
      return cs !== fv;
    case 'gt':
      return cs.localeCompare(fv) > 0;
    case 'gte':
      return cs.localeCompare(fv) >= 0;
    case 'lt':
      return cs.localeCompare(fv) < 0;
    case 'lte':
      return cs.localeCompare(fv) <= 0;
    default:
      return false;
  }
}

/**
 * 行が全フィルタ条件（AND）を満たすかを判定する。
 * @param row - 行データ。
 * @param columns - 列メタデータ。
 * @param filters - フィルタ条件の配列。
 */
function rowMatchesFilters(
  row: readonly unknown[],
  columns: readonly QueryColumn[],
  filters: readonly ResultFilterCondition[],
): boolean {
  for (const filter of filters) {
    const col = columns[filter.columnIndex];
    if (!col) return false;
    if (!matchesFilter(row[filter.columnIndex], col.type, filter.op, filter.value)) return false;
  }
  return true;
}

/**
 * 全列対象の部分一致検索（大文字小文字無視）にマッチするかを判定する。
 * @param row - 行データ。
 * @param needle - 小文字化済みの検索語。
 */
function rowMatchesSearch(row: readonly unknown[], needle: string): boolean {
  return row.some((cell) => cellTextLower(cell).includes(needle));
}

/** sort 用に保持するマッチ行。seq は元のマッチ順（安定ソートのタイブレーク）。 */
interface SortEntry {
  row: unknown[];
  seq: number;
}

/**
 * 結果行に filter / search / sort / ページングをストリーミング適用する。
 *
 * 全行を配列へ載せず 1 パスで評価する。保持する行数の上限:
 * - sort なし: limit 件（マッチ順位が [offset, offset + limit) の行のみ保持）
 * - sort あり: 2 * (offset + limit) 件（有界選択のバッファ。溢れたらソートして
 *   先頭 offset + limit 件へ切り詰める）
 * 呼び出し側は offset + limit を RESULT_SEARCH_MAX_WINDOW 以下に制限すること。
 *
 * @param columns - 列メタデータ。
 * @param rows - 評価対象の行ソース（同期配列または非同期ストリーム）。
 * @param request - 探索リクエスト。
 * @returns ページ行、フィルタ後の総マッチ数、フィルタ前の総行数。
 */
export async function searchRowsStream(
  columns: QueryColumn[],
  rows: RowSource,
  request: ResultSearchRequest,
): Promise<{ rows: unknown[][]; totalMatched: number; totalRows: number }> {
  const filters = request.filters ?? [];
  const needle = (request.search ?? '').trim().toLowerCase();
  const windowEnd = request.offset + request.limit;

  let totalRows = 0;
  let totalMatched = 0;

  // sort なし: マッチ順位がページ窓内の行だけを保持する。
  const pageRows: unknown[][] = [];

  // sort あり: 有界選択のバッファ。長さが 2 * windowEnd を超えたら
  // ソートして先頭 windowEnd 件へ切り詰めることで保持行数を有界にする。
  const sortBuffer: SortEntry[] = [];
  const sort = request.sort;
  const sortNumeric = sort ? isNumericType(columns[sort.columnIndex]?.type ?? '') : false;
  const sortFactor = sort?.dir === 'desc' ? -1 : 1;
  // compareValues の結果に factor を掛け、同値は元のマッチ順で並べる（安定ソート相当）。
  const compareEntries = (x: SortEntry, y: SortEntry): number => {
    const cmp = compareValues(x.row[sort!.columnIndex], y.row[sort!.columnIndex], sortNumeric);
    return cmp !== 0 ? cmp * sortFactor : x.seq - y.seq;
  };

  for await (const row of rows) {
    totalRows += 1;
    if (!rowMatchesFilters(row, columns, filters)) continue;
    if (needle && !rowMatchesSearch(row, needle)) continue;
    const matchSeq = totalMatched;
    totalMatched += 1;

    if (!sort) {
      // マッチ順位が窓の手前/後ろの行は保持せずカウントだけ進める。
      if (matchSeq >= request.offset && matchSeq < windowEnd) {
        pageRows.push([...row]);
      }
      continue;
    }

    sortBuffer.push({ row: [...row], seq: matchSeq });
    if (sortBuffer.length > 2 * windowEnd) {
      sortBuffer.sort(compareEntries);
      sortBuffer.length = windowEnd;
    }
  }

  if (!sort) {
    return { rows: pageRows, totalMatched, totalRows };
  }

  sortBuffer.sort(compareEntries);
  return {
    rows: sortBuffer.slice(request.offset, windowEnd).map((entry) => entry.row),
    totalMatched,
    totalRows,
  };
}

/**
 * min/max 更新用に 2 値を比較する。NULL は呼び出し元で除外済み。
 * @param a - 左辺。
 * @param b - 右辺。
 * @param numeric - 数値型列として比較するか。
 */
function compareForMinMax(a: unknown, b: unknown, numeric: boolean): number {
  if (numeric) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/** profileRowsStream が列ごとに保持する集計状態。 */
interface ColumnProfileState {
  nullCount: number;
  // distinct 値ごとの出現回数。key は 100 文字で切り詰めた文字列表現
  //（長い値は切り詰めた形で distinct 追跡する）。上限 DISTINCT_TRACK_LIMIT 件。
  counts: Map<string, { count: number; firstIndex: number }>;
  distinctOverflow: boolean;
  nextDistinctIndex: number;
  minVal: unknown;
  maxVal: unknown;
  hasMinMax: boolean;
}

/**
 * 結果行の列ごとプロファイルをストリーミング計算する。
 *
 * 1 パスの逐次処理で、列ごとに保持する状態は distinct Map（上限 10,000 件、
 * key は 100 文字切り詰め済み文字列）と min/max と null 数のみ。行数に対して有界。
 *
 * @param columns - 列メタデータ。
 * @param rows - 評価対象の行ソース（同期配列または非同期ストリーム）。
 * @returns 列ごとのプロファイル配列と走査した総行数。
 */
export async function profileRowsStream(
  columns: QueryColumn[],
  rows: RowSource,
): Promise<{ profiles: ResultColumnProfile[]; rowCount: number }> {
  const states: ColumnProfileState[] = columns.map(() => ({
    nullCount: 0,
    counts: new Map(),
    distinctOverflow: false,
    nextDistinctIndex: 0,
    minVal: undefined,
    maxVal: undefined,
    hasMinMax: false,
  }));
  const numericFlags = columns.map((col) => isNumericType(col.type));

  let rowCount = 0;
  for await (const row of rows) {
    rowCount += 1;
    for (let colIndex = 0; colIndex < columns.length; colIndex++) {
      const state = states[colIndex]!;
      const cell = row[colIndex];
      if (isNullCell(cell)) {
        state.nullCount += 1;
        continue;
      }

      const key = truncateValueText(cellTextRaw(cell));
      const existing = state.counts.get(key);
      if (existing) {
        existing.count += 1;
      } else if (!state.distinctOverflow) {
        if (state.counts.size >= DISTINCT_TRACK_LIMIT) {
          // 追跡上限到達。以後は既出値のカウントのみ継続し、新規値は無視する。
          state.distinctOverflow = true;
        } else {
          state.counts.set(key, { count: 1, firstIndex: state.nextDistinctIndex });
          state.nextDistinctIndex += 1;
        }
      }

      const numeric = numericFlags[colIndex]!;
      if (!state.hasMinMax) {
        state.minVal = cell;
        state.maxVal = cell;
        state.hasMinMax = true;
      } else {
        if (compareForMinMax(cell, state.minVal, numeric) < 0) state.minVal = cell;
        if (compareForMinMax(cell, state.maxVal, numeric) > 0) state.maxVal = cell;
      }
    }
  }

  const profiles = columns.map((col, colIndex) => {
    const state = states[colIndex]!;
    const topValues = [...state.counts.entries()]
      .sort((a, b) => {
        const byCount = b[1].count - a[1].count;
        // 同数は出現順（firstIndex が小さい方が先）。
        return byCount !== 0 ? byCount : a[1].firstIndex - b[1].firstIndex;
      })
      .slice(0, RESULT_PROFILE_TOP_VALUES)
      .map(([value, { count }]) => ({ value, count }));

    const profile: ResultColumnProfile = {
      name: col.name,
      type: col.type,
      nullCount: state.nullCount,
      distinctCount: state.counts.size,
      distinctOverflow: state.distinctOverflow,
      topValues,
    };
    if (state.hasMinMax) {
      profile.min = truncateValueText(String(state.minVal));
      profile.max = truncateValueText(String(state.maxVal));
    }
    return profile;
  });

  return { profiles, rowCount };
}

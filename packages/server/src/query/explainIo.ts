/**
 * このファイルは Trino の `EXPLAIN (TYPE IO, FORMAT JSON)` 出力をパースする
 * ユーティリティを提供する（Query Guard 機能の一部）。
 *
 * 役割: `estimateService.ts` が EXPLAIN 文を実行して受け取った単一の varchar
 * セル（JSON 文字列）を、Query Guard の判定（`guardVerdict.ts`）に必要な
 * 「スキャン量（バイト数や行数）」と「テーブルごとの内訳」に変換する。
 * 統計情報を持たないテーブルに対して Trino が返す `"NaN"` のような非数値も
 * 安全に `null`（不明）として扱う。
 *
 * アーキテクチャ上の位置づけ: `estimateService.ts` からのみ呼ばれる純粋な
 * パーサー。Trino や HTTP との通信は行わず、文字列 -> 構造化データの変換のみに
 * 専念する。
 */
import type { EstimateTable } from '@hubble/contracts';

/**
 * Parser for Trino's `EXPLAIN (TYPE IO, FORMAT JSON)` output (Query Guard).
 *
 * The statement returns a single varchar cell holding a JSON document of the
 * shape:
 *
 *   {
 *     "inputTableColumnInfos": [
 *       { "table": { "catalog", "schemaTable": { "schema", "table" } },
 *         "estimate": { "outputRowCount", "outputSizeInBytes", ... } }
 *     ],
 *     "estimate": { "outputRowCount", "outputSizeInBytes", ... }   // query output
 *   }
 *
 * Statistics-less tables emit the *string* `"NaN"` (and possibly `"Infinity"`)
 * in place of numbers; those — and any non-finite value — are treated as `null`
 * (unknown). Per-table scan figures are summed; a sum is `null` only when no
 * input table contributed a finite value.
 *
 * Trino の `EXPLAIN (TYPE IO, FORMAT JSON)` 出力のパーサー（Query Guard 機能）。
 *
 * このステートメントは単一の varchar セルとして、上記のような形状の JSON
 * ドキュメントを返す。統計情報を持たないテーブルは数値の代わりに *文字列*
 * `"NaN"`（場合によっては `"Infinity"`）を返してくる。これらと、その他の
 * 非有限値はすべて `null`（不明）として扱う。テーブルごとのスキャン量は
 * 合算するが、合算値が `null` になるのは、入力テーブルのどれ 1 つも
 * 有限値を提供しなかった場合のみ。
 */

/** A finite number, or `null` when the value is missing/`"NaN"`/non-finite. */
// 値を有限な number として解釈できる場合はそのまま返し、欠損・`"NaN"`
// （文字列）・非有限値（Infinity 等）の場合は null（不明）を返す。
function finiteOrNull(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

// EXPLAIN IO JSON 内の estimate オブジェクトの生の形（未検証の unknown 値）。
interface RawEstimate {
  outputRowCount?: unknown;
  outputSizeInBytes?: unknown;
}

// EXPLAIN IO JSON 内の inputTableColumnInfos 要素の生の形。
interface RawInputTable {
  table?: {
    catalog?: unknown;
    schemaTable?: { schema?: unknown; table?: unknown };
  };
  estimate?: RawEstimate;
}

// EXPLAIN IO JSON ドキュメント全体の生の形。
interface RawIoPlan {
  inputTableColumnInfos?: RawInputTable[];
  estimate?: RawEstimate;
}

// パース結果（Query Guard の判定にそのまま使える構造化データ）。
export interface ParsedIoPlan {
  /** Sum of input-table `outputSizeInBytes` (null when wholly unknown). */
  // 入力テーブルの `outputSizeInBytes` の合算値（全テーブルが不明なら null）。
  scanBytes: number | null;
  /** Sum of input-table `outputRowCount` (null when wholly unknown). */
  // 入力テーブルの `outputRowCount` の合算値（全テーブルが不明なら null）。
  scanRows: number | null;
  /** Top-level query output estimate. */
  // クエリ全体の出力（トップレベル estimate）に関する見積もり。
  outputRows: number | null;
  outputBytes: number | null;
  tables: EstimateTable[];
}

// unknown 値を文字列として安全に取り出す（文字列でなければ空文字）。
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Parse the single-cell EXPLAIN IO JSON string into scan totals + per-table
 * figures. Returns `undefined` when the cell is not a valid IO plan (e.g. Trino
 * echoed an unsupported statement verbatim instead of a JSON document), which
 * the caller maps to `status: 'unsupported'`.
 *
 * EXPLAIN IO の単一セル JSON 文字列を、スキャン合計値とテーブルごとの内訳へ
 * パースする。セルが有効な IO プランでない場合（例えば Trino が非対応の
 * ステートメントを JSON ドキュメントの代わりにそのままエコーバックした場合）
 * は `undefined` を返し、呼び出し元（estimateService.ts）がこれを
 * `status: 'unsupported'` にマッピングする。
 */
export function parseExplainIoJson(cell: string): ParsedIoPlan | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(cell);
  } catch {
    // JSON として解釈できない = IO プランではない（非対応ステートメントの
    // エコーバックなど）。
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const plan = raw as RawIoPlan;
  // A valid IO plan always carries `inputTableColumnInfos` (possibly empty) and
  // an `estimate` object. Absence of both means it is not an IO plan.
  // 有効な IO プランは必ず `inputTableColumnInfos`（空配列でもよい）と
  // `estimate` オブジェクトのどちらかを持つ。両方とも欠けている場合は
  // IO プランではないと判断する。
  if (!Array.isArray(plan.inputTableColumnInfos) && typeof plan.estimate !== 'object') {
    return undefined;
  }

  const tables: EstimateTable[] = [];
  let scanBytes: number | null = null;
  let scanRows: number | null = null;

  // 入力テーブルごとに行数とバイト数を取り出し、テーブル別内訳（tables）へ
  // 積み上げつつ、全体の合算値（scanRows/scanBytes）を加算していく。
  // 値が null（不明）のテーブルは合算対象から除外される（=無視されるだけで
  // エラーにはしない）。
  for (const input of plan.inputTableColumnInfos ?? []) {
    const rows = finiteOrNull(input.estimate?.outputRowCount);
    const bytes = finiteOrNull(input.estimate?.outputSizeInBytes);
    tables.push({
      catalog: str(input.table?.catalog),
      schema: str(input.table?.schemaTable?.schema),
      table: str(input.table?.schemaTable?.table),
      rows,
      bytes,
    });
    if (rows !== null) scanRows = (scanRows ?? 0) + rows;
    if (bytes !== null) scanBytes = (scanBytes ?? 0) + bytes;
  }

  return {
    scanBytes,
    scanRows,
    outputRows: finiteOrNull(plan.estimate?.outputRowCount),
    outputBytes: finiteOrNull(plan.estimate?.outputSizeInBytes),
    tables,
  };
}

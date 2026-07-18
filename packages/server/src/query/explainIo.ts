/**
 * このファイルは Trino の `EXPLAIN (TYPE IO, FORMAT JSON)` 出力をパースする
 * ユーティリティを提供する（Query Guard 機能の一部）。
 *
 * 役割: EXPLAIN 文を実行して受け取った単一の varchar セル（JSON 文字列）を、
 * Query Guard の判定（`guardVerdict.ts`）に必要な「スキャン量（バイト数や
 * 行数）」と「テーブルごとの内訳」に変換する `parseExplainIoJson`、および
 * 書き込み先の有無だけを判定する `classifyIoPlanWrites` を提供する。
 * 統計情報を持たないテーブルに対して Trino が返す `"NaN"` のような非数値も
 * 安全に `null`（不明）として扱う。
 *
 * アーキテクチャ上の位置づけ: EXPLAIN の実行自体は行わない純粋なパーサーで、
 * Trino や HTTP との通信は行わない。`parseExplainIoJson` は
 * `engine/trinoEstimate.ts`（EXPLAIN 実行本体）から、`classifyIoPlanWrites`
 * は `rbac/writeCheck.ts`（query.write 権限チェック）から呼ばれる。
 */
import type { EstimateTable } from '@hubble/contracts';

/**
 * Trino の `EXPLAIN (TYPE IO, FORMAT JSON)` 出力のパーサー（Query Guard 機能）。
 *
 * このステートメントは単一の varchar セルとして、次のような形状の JSON
 *
 *   {
 *     "inputTableColumnInfos": [
 *       { "table": { "catalog", "schemaTable": { "schema", "table" } },
 *         "estimate": { "outputRowCount", "outputSizeInBytes", ... } }
 *     ],
 *     "estimate": { "outputRowCount", "outputSizeInBytes", ... }   // クエリ全体の出力
 *   }
 * ドキュメントを返す。統計情報を持たないテーブルは数値の代わりに *文字列*
 * `"NaN"`（場合によっては `"Infinity"`）を返してくる。これらと、その他の
 * 非有限値はすべて `null`（不明）として扱う。テーブルごとの有限なスキャン量は
 * 合算しつつ、行数とバイト数ごとに全入力テーブルを見積もれたかも保持する。
 * 入力テーブルが空ならスキャン量は 0 で完全、入力が全て不明なら合計値は null で
 * 不完全、既知と不明が混在する場合は既知小計を保ったまま不完全とする。
 */

// 値を有限な number として解釈できる場合はそのまま返し、欠損、`"NaN"`
// （文字列）、非有限値（Infinity 等）の場合は null（不明）を返す。
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
  outputTableColumnInfos?: RawInputTable[];
  estimate?: RawEstimate;
}

/** パース結果（Query Guard の判定にそのまま使える構造化データ）。 */
export interface ParsedIoPlan {
  /** EXPLAIN IO が書き込み先テーブルを報告しているか。 */
  hasWriteOutputs: boolean;
  /** 入力テーブルの `outputSizeInBytes` の合算値（全テーブルが不明なら null）。 */
  scanBytes: number | null;
  /** 全入力テーブルのバイト数を見積もれた場合は true。 */
  scanBytesComplete: boolean;
  /** 入力テーブルの `outputRowCount` の合算値（全テーブルが不明なら null）。 */
  scanRows: number | null;
  /** 全入力テーブルの行数を見積もれた場合は true。 */
  scanRowsComplete: boolean;
  /** クエリ全体の出力（トップレベル estimate）に関する見積もり。 */
  outputRows: number | null;
  outputBytes: number | null;
  tables: EstimateTable[];
}

// unknown 値を文字列として安全に取り出す（文字列でなければ空文字）。
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * EXPLAIN IO の単一セル JSON 文字列を、スキャン合計値とテーブルごとの内訳へ
 * パースする。セルが有効な IO プランでない場合（例えば Trino が非対応の
 * ステートメントを JSON ドキュメントの代わりにそのままエコーバックした場合）
 * は `undefined` を返し、呼び出し元（engine/trinoEstimate.ts の buildResult）
 * がこれを `status: 'unsupported'` にマッピングする。
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
  // 有効な IO プランは必ず `inputTableColumnInfos`（空配列でもよい）と
  // `estimate` オブジェクトのどちらかを持つ。両方とも欠けている場合は
  // IO プランではないと判断する。
  if (!Array.isArray(plan.inputTableColumnInfos) && typeof plan.estimate !== 'object') {
    return undefined;
  }

  const tables: EstimateTable[] = [];
  let scanBytes = 0;
  let scanRows = 0;
  let hasKnownBytes = false;
  let hasKnownRows = false;
  const hasInputTableList = Array.isArray(plan.inputTableColumnInfos);
  let scanBytesComplete = hasInputTableList;
  let scanRowsComplete = hasInputTableList;
  const inputs = hasInputTableList ? plan.inputTableColumnInfos! : [];

  // 入力テーブルごとに行数とバイト数を取り出し、テーブル別内訳（tables）へ
  // 積み上げつつ、全体の合算値（scanRows/scanBytes）を加算していく。
  // 値が null のテーブルは有限値の小計には含めないが、完全性を false にして
  // Query Guard が小計を全量見積もりと誤認しないようにする。
  for (const input of inputs) {
    const rows = finiteOrNull(input.estimate?.outputRowCount);
    const bytes = finiteOrNull(input.estimate?.outputSizeInBytes);
    tables.push({
      catalog: str(input.table?.catalog),
      schema: str(input.table?.schemaTable?.schema),
      table: str(input.table?.schemaTable?.table),
      rows,
      bytes,
    });
    if (rows === null) {
      scanRowsComplete = false;
    } else {
      scanRows += rows;
      hasKnownRows = true;
    }
    if (bytes === null) {
      scanBytesComplete = false;
    } else {
      scanBytes += bytes;
      hasKnownBytes = true;
    }
  }

  return {
    hasWriteOutputs: (plan.outputTableColumnInfos?.length ?? 0) > 0,
    scanBytes: hasKnownBytes || (hasInputTableList && inputs.length === 0) ? scanBytes : null,
    scanBytesComplete,
    scanRows: hasKnownRows || (hasInputTableList && inputs.length === 0) ? scanRows : null,
    scanRowsComplete,
    outputRows: finiteOrNull(plan.estimate?.outputRowCount),
    outputBytes: finiteOrNull(plan.estimate?.outputSizeInBytes),
    tables,
  };
}

/**
 * EXPLAIN IO の JSON セルから書き込み先の有無を判定する。
 * パース不能なセルは `unclassified` を返す（read-only ロールでは拒否する）。
 *
 * Trino が生成した `EXPLAIN (TYPE IO, FORMAT JSON)` の `outputTableColumnInfos`
 * の有無で判定する Trino 専用のロジックであり、PostgreSQL と MySQL は
 * `ioExplainExecution` を実装していないためこの関数を経由しない
 * （それらの書き込み判定は rbac/writeCheck.ts のキーワード分類が担う）。
 */
export function classifyIoPlanWrites(cell: string): boolean | 'unclassified' {
  const parsed = parseExplainIoJson(cell);
  if (parsed !== undefined) return parsed.hasWriteOutputs;
  try {
    const raw = JSON.parse(cell) as RawIoPlan;
    if (Array.isArray(raw.outputTableColumnInfos) && raw.outputTableColumnInfos.length > 0) {
      return true;
    }
  } catch {
    // JSON として解釈できない。
  }
  return 'unclassified';
}

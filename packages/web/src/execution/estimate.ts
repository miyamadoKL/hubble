// Query Guard estimate layer (Query Guard feature).
//
// Three concerns, all pure / synchronous except the one fetch helper:
//   - estimateQuery        : POST /api/queries/estimate (typed, zod-validated)
//   - resolveEstimateInput : build the *exact* statement the run path will send
//                            (variable substitution + auto-LIMIT) or a skip
//                            reason — so the estimate matches the run byte-for-byte
//                            and hits the server's (principal,…,statement) cache.
//   - estimatePresentation : map an EstimateResult to a compact UI descriptor
//                            (tone / label / whether to show / whether to block).
//   - parseQueryBlocked    : pull the typed { estimate, limits } out of a 422
//                            QUERY_BLOCKED error's `details` for the ErrorPanel.
//
// Everything here is editor-agnostic and exercised directly by vitest.
//
// ==== ファイルの責務（日本語） ================================================
// Query Guard 機能の「見積り (estimate)」レイヤー。実行前に SQL のスキャン量を
// 見積もり、閾値を超える場合は警告/ブロックする一連のロジックを提供する。
// 中心となる 4 つの関心事:
//   - estimateQuery        : `POST /api/queries/estimate` を叩く薄い API 呼び出し。
//   - resolveEstimateInput  : 実行パスが実際に送るステートメントと *完全に同一の
//                             文字列* を組み立てる（変数置換 + auto-LIMIT 適用）。
//                             これにより見積りと本実行が byte-for-byte 一致し、
//                             サーバー側の (principal, …, statement) キャッシュに
//                             ヒットする。
//   - estimatePresentation  : EstimateResult をコンパクトな UI 記述子（色/ラベル/
//                             表示可否/ブロック可否）へ変換する。
//   - parseQueryBlocked     : 422 QUERY_BLOCKED エラーの details から
//                             型付きの { estimate, limits } を取り出す
//                             （ErrorPanel での詳細表示用）。
// いずれもエディタに依存しない純粋なロジックで、vitest から直接検証できる。
// ============================================================================

import {
  estimateRequestSchema,
  estimateResultSchema,
  guardConfigSchema,
  type ApiErrorDetail,
  type EstimateResult,
  type GuardConfig,
  type GuardDecision,
} from '@hubble/contracts';
import { apiFetch, apiRoutes } from '../api/client';
import { substituteVariables } from '../notebook/variables';
import { withAutoLimit } from './sql';
import { resolveExecution, type CaretSelection } from './executionUnit';

/**
 * `POST /api/queries/estimate` → an `EstimateResult`.
 * 指定したステートメントのスキャン量見積りをサーバーに問い合わせる。
 */
export function estimateQuery(request: {
  statement: string;
  catalog?: string;
  schema?: string;
  datasourceId?: string;
}): Promise<EstimateResult> {
  const body = estimateRequestSchema.parse(request);
  return apiFetch(estimateResultSchema, apiRoutes.queryEstimate(), { method: 'POST', body });
}

/**
 * Inputs that mirror a run, so the estimated statement is identical to it.
 * 実行パスの入力を再現するための情報。ここから組み立てるステートメントは、
 * 実際の実行時に送信されるものと完全に一致させる。
 */
export interface ResolveEstimateInput {
  /** The raw statement text of the execution unit (pre-substitution). */
  /** 実行単位の生のステートメントテキスト（変数置換前）。 */
  unitText: string;
  /** Notebook variable values, name → current value. */
  /** notebook の変数値（変数名 → 現在の入力値）。 */
  variableValues: Record<string, string>;
  /** Auto-LIMIT toggle + value, exactly as the run path uses them. */
  /** auto-LIMIT の有効/無効とその上限値。実行パスと同じ値を渡す。 */
  autoLimit: boolean;
  limit: number;
}

/** Why an estimate was skipped (kept out of the request entirely). */
/** 見積りをスキップした理由（そもそも API を呼ばなかった場合の理由）。 */
export type EstimateSkipReason = 'empty' | 'missing-variables';

export type ResolveEstimateResult =
  | { ok: true; statement: string }
  | { ok: false; reason: EstimateSkipReason };

/**
 * Produce the statement that an estimate should be run against — identical to
 * the one the execution store will send (`executionStore.runUnit`): variables
 * substituted first, then `withAutoLimit` applied when the toggle is on. A unit
 * with unresolved `${…}` variables is *not* estimated (the run would be blocked
 * by the same missing-variable check), and neither is an empty unit.
 */
export function resolveEstimateInput(input: ResolveEstimateInput): ResolveEstimateResult {
  // 空文字（トリム後）は見積り対象にしない。
  const trimmed = input.unitText.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // 変数置換を実行パスと同じ手順で行う。未解決の変数があれば、そのまま
  // 実行しても Query Guard 以前にブロックされるため、見積り自体を諦める。
  const { text, missing } = substituteVariables(input.unitText, input.variableValues);
  if (missing.length > 0) return { ok: false, reason: 'missing-variables' };

  // auto-LIMIT が有効なら、実行パスと同じ規則で LIMIT 句を付与する。
  const statement = input.autoLimit ? withAutoLimit(text, input.limit).sql : text;
  return { ok: true, statement };
}

/** Why the live estimate was skipped (so the strip can decide to hide). */
/**
 * ライブ見積り（キャレット位置に応じてリアルタイムに表示する見積り）を
 * スキップした理由。表示ストリップが「非表示にすべきか」を判断するために使う。
 */
export type LiveEstimateSkip =
  | 'guard-off' // mode=off — never call the API
  | 'empty' // nothing under the caret / selection
  | 'parse-error' // the unit doesn't parse cleanly yet (user mid-edit)
  | 'missing-variables'; // unresolved ${…} — the run itself would be blocked

export type LiveEstimateTarget =
  | { estimate: true; statement: string }
  | { estimate: false; reason: LiveEstimateSkip };

export interface LiveEstimateInput {
  /** Full cell source. */
  /** セル全体のソーステキスト。 */
  source: string;
  /** Current selection/caret (the run path's `resolveExecution` input). */
  /** 現在の選択範囲/キャレット位置（実行パスの `resolveExecution` と同じ入力）。 */
  selection: CaretSelection;
  /** Notebook variable values. */
  /** notebook の変数値。 */
  variableValues: Record<string, string>;
  /** Auto-LIMIT toggle + value, identical to the run path. */
  /** auto-LIMIT の有効/無効と上限値（実行パスと同一の値）。 */
  autoLimit: boolean;
  limit: number;
  /** Guard mode from /api/config — 'off' skips estimation entirely. */
  /** `/api/config` から取得した Query Guard のモード。'off' なら見積り自体を行わない。 */
  guardMode: 'off' | 'warn' | 'enforce';
  /**
   * Parse-cleanliness predicate over the *resolved* statement, true when the
   * ANTLR parser produced no error markers. Injected so this stays pure/testable
   * (the editor wires in `parseStatement(...).markers.length === 0`).
   *
   * 「解決済み（変数置換後）のステートメント」がクリーンにパースできるかを
   * 判定する述語。ANTLR パーサーがエラーマーカーを出さなければ true。
   * この関数を純粋かつテスト可能に保つため外部から注入する形にしており、
   * エディタ側は `parseStatement(...).markers.length === 0` を渡す。
   */
  parsesClean: (statement: string) => boolean;
}

/**
 * Decide what (if anything) to estimate for the cell's current caret/selection,
 * applying the user's rule "estimate only when it parses": guard on, a non-empty
 * unit, all variables resolved, and the resolved statement parses clean. The
 * statement returned is byte-identical to what the run path would send (variable
 * substitution then auto-LIMIT), so it hits the server's estimate cache and the
 * run-time block is consistent with what the strip showed.
 */
export function computeLiveEstimateTarget(input: LiveEstimateInput): LiveEstimateTarget {
  // Query Guard が off なら、そもそも見積り API を呼ばない。
  if (input.guardMode === 'off') return { estimate: false, reason: 'guard-off' };

  // 実行パスと同じロジックで「今、何を実行することになるか」を求める。
  const units = resolveExecution(input.source, input.selection);
  const unit = units[0];
  if (!unit || unit.text.trim().length === 0) return { estimate: false, reason: 'empty' };

  // 実行パスと byte-for-byte 一致するステートメントを組み立てる。
  const resolved = resolveEstimateInput({
    unitText: unit.text,
    variableValues: input.variableValues,
    autoLimit: input.autoLimit,
    limit: input.limit,
  });
  if (!resolved.ok) {
    return { estimate: false, reason: resolved.reason === 'empty' ? 'empty' : 'missing-variables' };
  }

  // Parse the *substituted, pre-auto-LIMIT* unit text — substitution can change
  // validity (e.g. `${n}` → a number), and the appended LIMIT is always valid.
  // 「変数置換後かつ auto-LIMIT 付与前」のテキストをパースチェックする。変数置換
  // によって構文的な妥当性が変わりうる（例: `${n}` → 数値）ため置換後を見る
  // 必要があり、一方で付与される LIMIT 句は常に妥当なので確認は不要。
  const { text: substituted } = substituteVariables(unit.text, input.variableValues);
  if (!input.parsesClean(substituted)) return { estimate: false, reason: 'parse-error' };

  return { estimate: true, statement: resolved.statement };
}

/** Visual tone of the estimate strip, mapped 1:1 to a design token family. */
/** 見積りストリップの見た目トーン。デザイントークンのファミリーに 1:1 対応する。 */
export type EstimateTone = 'info' | 'warning' | 'error' | 'unavailable';

/** Compact UI descriptor derived from an `EstimateResult` + the guard config. */
/**
 * `EstimateResult` と guard 設定から導出する、コンパクトな UI 用記述子。
 * 見積りストリップの表示に必要な情報をここに集約する。
 */
export interface EstimatePresentation {
  /** Whether the strip should render at all. */
  /** ストリップをそもそも描画すべきか。 */
  visible: boolean;
  /** Tone driving the strip's color (design token family). */
  /** ストリップの色調を決めるトーン。 */
  tone: EstimateTone;
  /** True when the run must be blocked (decision === 'block'). */
  /** 実行をブロックすべき場合 true（verdict.decision === 'block'）。 */
  blocked: boolean;
  /** Scan figures to display, when known. */
  /** 表示すべきスキャン行数/バイト数（不明なら null）。 */
  scanRows: number | null;
  scanBytes: number | null;
  /** Time estimate, only when the server provided one. */
  /** サーバーが返した場合のみ設定される所要時間見積り（秒）。 */
  estimatedSeconds: number | null;
  /** Short status word shown in the strip ('estimate' | 'estimate unavailable'). */
  /** ストリップに表示する短いステータス文言。 */
  label: string;
  /** Human-readable reasons (warn/block), surfaced in a tooltip / inline. */
  /** warn/block の理由（人間が読める文字列）。ツールチップ等に表示する。 */
  reasons: string[];
}

// 「表示しない」ことを表す共有の定数。disabled/unsupported のときに使い回す。
const HIDDEN: EstimatePresentation = {
  visible: false,
  tone: 'info',
  blocked: false,
  scanRows: null,
  scanBytes: null,
  estimatedSeconds: null,
  label: '',
  reasons: [],
};

/** Map a guard decision to the strip's tone. */
/** guard の判定結果 (GuardDecision) をストリップのトーンへマッピングする。 */
function toneForDecision(decision: GuardDecision): EstimateTone {
  if (decision === 'block') return 'error';
  if (decision === 'warn') return 'warning';
  return 'info';
}

/**
 * Map an estimate result to its compact strip presentation.
 *
 *  - `disabled` / `unsupported`  → hidden (nothing to say).
 *  - `unavailable`               → a muted "estimate unavailable", escalated to
 *                                  warn/block tone when the verdict asks for it.
 *  - `estimated`                 → scan figures + the verdict's tone.
 */
export function estimatePresentation(result: EstimateResult): EstimatePresentation {
  // disabled/unsupported: そもそも見積れない/不要なケースなので何も表示しない。
  if (result.status === 'disabled' || result.status === 'unsupported') {
    return HIDDEN;
  }

  const decision = result.verdict.decision;
  const blocked = decision === 'block';

  if (result.status === 'unavailable') {
    // 見積り自体は失敗したが verdict は返っている（allow 以外なら guard 側の
    // トーンを優先し、allow のときだけ「unavailable」の控えめな見た目にする）。
    return {
      visible: true,
      tone: decision === 'allow' ? 'unavailable' : toneForDecision(decision),
      blocked,
      scanRows: null,
      scanBytes: null,
      estimatedSeconds: null,
      label: 'estimate unavailable',
      reasons: result.verdict.reasons,
    };
  }

  // status === 'estimated'
  // 見積りに成功: スキャン行数/バイト数と、判定に応じたトーンを表示する。
  return {
    visible: true,
    tone: toneForDecision(decision),
    blocked,
    scanRows: result.scanRows,
    scanBytes: result.scanBytes,
    estimatedSeconds: result.estimatedSeconds,
    label: 'estimated scan',
    reasons: result.verdict.reasons,
  };
}

/** The structured payload a 422 `QUERY_BLOCKED` error carries in `details`. */
/** 422 `QUERY_BLOCKED` エラーが `details` に持つ構造化ペイロード。 */
export interface QueryBlockedDetails {
  estimate: EstimateResult;
  limits: GuardConfig;
}

// limits を部分的なスキーマとして扱う: サーバーがブロック時のスナップショット
// では一部フィールド（bytesPerSecond 等）を省略することがあるため。
const partialGuardConfig = guardConfigSchema.partial();

/**
 * Extract a typed `{ estimate, limits }` from a `QUERY_BLOCKED` error detail.
 * Returns undefined for any other error (or a malformed payload), so callers
 * can fall back to the plain message. Tolerant of a partial `limits` snapshot
 * (the server omits `bytesPerSecond` in the block snapshot).
 */
export function parseQueryBlocked(error: ApiErrorDetail): QueryBlockedDetails | undefined {
  // QUERY_BLOCKED 以外のエラーコード、または details が無ければ対象外。
  if (error.code !== 'QUERY_BLOCKED' || !error.details) return undefined;
  const raw = error.details as { estimate?: unknown; limits?: unknown };
  const estimate = estimateResultSchema.safeParse(raw.estimate);
  if (!estimate.success) return undefined;
  const limits = partialGuardConfig.safeParse(raw.limits ?? {});
  return {
    estimate: estimate.data,
    // limits が部分的にしか無い場合に備え、安全なデフォルト値で埋めてから
    // 実際に届いたフィールドで上書きする。
    limits: {
      maxScanBytes: 0,
      maxScanRows: 0,
      bytesPerSecond: 0,
      mode: 'enforce',
      onUnknown: 'warn',
      ...(limits.success ? limits.data : {}),
    },
  };
}

/** True when an error detail is a Query Guard block (422 QUERY_BLOCKED). */
/** エラー詳細が Query Guard によるブロック（422 QUERY_BLOCKED）かどうか。 */
export function isQueryBlocked(error: ApiErrorDetail | undefined): boolean {
  return error?.code === 'QUERY_BLOCKED';
}

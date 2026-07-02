/**
 * このファイルは Query Guard 機能で使う小さなヘルパー群を提供する。
 *
 * 役割: HTTP ルート層（担当外）が直接参照する 2 つの小関数のみを持つ。
 * ガードが無効（`mode=off`）なときに Trino へ問い合わせずに返す「無害な」
 * EstimateResult と、`QUERY_BLOCKED` エラーの `details` に埋め込む現在の
 * 上限値スナップショットを作る。実際の判定ロジック（allow/warn/block）は
 * `guardVerdict.ts`、EXPLAIN の実行と見積もりは `estimateService.ts` が
 * 担当し、このファイルはそれらを補助する薄いユーティリティ層に留まる。
 */
import type { EstimateResult } from '@hubble/contracts';
import type { ServerConfig } from '../config';

/**
 * Small Query Guard helpers shared by the HTTP layer (Query Guard feature):
 * the canned `disabled` estimate and the limits snapshot embedded in a
 * `QUERY_BLOCKED` error's `details`.
 *
 * HTTP 層が共有する小さな Query Guard ヘルパー（Query Guard 機能）:
 * 定型の `disabled` 見積もりと、`QUERY_BLOCKED` エラーの `details` に
 * 埋め込む上限値スナップショット。
 */

/** The estimate returned (without touching Trino) when the guard is off. */
// ガードが off のときに（Trino へは一切問い合わせず）返す固定の見積もり結果。
// verdict は常に allow、reasons は空で、見積もり値はすべて null。
export function disabledEstimate(): EstimateResult {
  return {
    status: 'disabled',
    scanBytes: null,
    scanRows: null,
    outputRows: null,
    outputBytes: null,
    estimatedSeconds: null,
    tables: [],
    verdict: { decision: 'allow', reasons: [] },
    elapsedMs: 0,
  };
}

/** The active guard limits, surfaced to the web alongside a block. */
// 現在有効なガード上限値のスナップショット。block 判定と一緒に web 側へ
// 返すことで、UI が「なぜブロックされたか／どの上限に基づくか」を表示できる。
export function guardLimitsSnapshot(config: ServerConfig): {
  mode: ServerConfig['guard']['mode'];
  maxScanBytes: number;
  maxScanRows: number;
  onUnknown: ServerConfig['guard']['onUnknown'];
} {
  return {
    mode: config.guard.mode,
    maxScanBytes: config.guard.maxScanBytes,
    maxScanRows: config.guard.maxScanRows,
    onUnknown: config.guard.onUnknown,
  };
}

/**
 * このファイルは Query Guard の判定ロジック（許可/警告/ブロックの決定）を
 * 提供する。
 *
 * 役割: EXPLAIN IO の見積もり結果（スキャン推定バイト数や行数、または
 * 見積もり不能を示すステータス）を渡すと、設定された上限値、モード、
 * 不明時ポリシーに基づいて `GuardVerdict`（decision + reasons）を返す
 * 純粋関数 `computeVerdict` を中心に構成される。副作用や I/O は一切持たず、
 * 単体テスト（guardVerdict.test.ts）で網羅的に検証されるロジックの核。
 *
 * アーキテクチャ上の位置づけ: `computeVerdict` は `engine/trinoEstimate.ts`
 * の `buildResult` からのみ呼ばれる。上限値やモードの取得元
 * （`ServerConfig` -> `EstimateGuardConfig`）や EXPLAIN の実行は関与せず、
 * あくまで「入力（見積もり値 + 設定）から出力（判定）を導く」変換のみを
 * 担当する。
 */
import type {
  EstimateStatus,
  GuardDecision,
  GuardMode,
  GuardOnUnknown,
  GuardVerdict,
} from '@hubble/contracts';

export interface GuardLimits {
  mode: GuardMode;
  /** スキャンバイト数の上限（0 = 無制限）。 */
  maxScanBytes: number;
  /** スキャン行数の上限（0 = 無制限）。 */
  maxScanRows: number;
  onUnknown: GuardOnUnknown;
}

export interface VerdictInput {
  status: EstimateStatus;
  /** 見積もられた入力スキャンバイト数（null = 不明）。 */
  scanBytes: number | null;
  /** 全入力テーブルのバイト数を見積もれた場合は true。 */
  scanBytesComplete: boolean;
  /** 見積もられた入力スキャン行数（null = 不明）。 */
  scanRows: number | null;
  /** 全入力テーブルの行数を見積もれた場合は true。 */
  scanRowsComplete: boolean;
}

// 理由メッセージを人間が読みやすいよう桁区切りにする: 6001215 -> "6,001,215"。
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

// 判定の重大度（deciding 用の内部指標）。allow < warn < block。
const SEVERITY: Record<GuardDecision, number> = { allow: 0, warn: 1, block: 2 };

// 2 つの判定のうち、より重大な（=強い制約を要求する）方を選ぶ。
function worse(a: GuardDecision, b: GuardDecision): GuardDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// ON_UNKNOWN ポリシーを、それが要求する判定へ変換する（1:1 対応）。
function onUnknownDecision(policy: GuardOnUnknown): GuardDecision {
  return policy;
}

/**
 * ガードの判定を計算する（純粋関数であり、このファイルの単体テスト対象）。
 *
 * 判定に寄与する「原因」は 2 種類ある:
 *  - 上限超過は `block` を要求する（実際の違反が要求し得る最も強い判定）。
 *  - 見積もり不能なクエリは ON_UNKNOWN が指定する判定
 *    （allow/warn/block のいずれか）を要求する。
 *
 * 複数の「要求」のうち最も強いものが採用され、その後 `warn` モードでは
 * `block` を `warn` に格下げする（warn モードは決してブロックしない）。
 * `unsupported`（EXPLAIN 非対応）と `disabled`（ガード off）は常に allow。
 */
export function computeVerdict(input: VerdictInput, limits: GuardLimits): GuardVerdict {
  // ガード対象外のステータスは判定を行わず常に allow で早期リターンする。
  if (input.status === 'unsupported' || input.status === 'disabled') {
    return { decision: 'allow', reasons: [] };
  }

  const reasons: string[] = [];
  // 各「原因」が要求する判定を requests に積み、最後に最も強いものを採用する。
  const requests: GuardDecision[] = [];
  const want = (decision: GuardDecision): void => {
    requests.push(decision);
  };
  // 上限が何も設定されていなければ保護すべき対象が無いため、見積もり不能で
  // あること自体は無意味になる。ON_UNKNOWN は実際に上限が設定されている
  // 場合にのみ適用される。
  const limitsConfigured = limits.maxScanBytes > 0 || limits.maxScanRows > 0;

  if (input.status === 'unavailable') {
    // EXPLAIN 自体が失敗した（トランスポート障害やタイムアウト等）ケース。
    // 見積もりが得られなかった以上、ON_UNKNOWN ポリシーに従う。
    const decision = onUnknownDecision(limits.onUnknown);
    if (limitsConfigured && decision !== 'allow') {
      reasons.push('Scan cost could not be estimated (estimation unavailable)');
      want(decision);
    }
  } else {
    // ここに来るのは status === 'estimated'、つまり EXPLAIN が成功し、
    // 少なくとも一部の見積もり値が得られたケース。
    const { scanBytes, scanRows, scanBytesComplete, scanRowsComplete } = input;
    const bytesKnown = scanBytes !== null;
    const rowsKnown = scanRows !== null;

    // バイト数や行数それぞれについて、値が判明していて、かつ上限を
    // 超えていれば block を要求し、人間可読な理由文を追加する。
    // 両方が同時に超過していれば理由も 2 件になる。
    if (limits.maxScanBytes > 0 && bytesKnown && scanBytes! > limits.maxScanBytes) {
      reasons.push(
        `Estimated scan of ${fmt(scanBytes!)} bytes exceeds the limit of ${fmt(
          limits.maxScanBytes,
        )} bytes`,
      );
      want('block');
    }
    if (limits.maxScanRows > 0 && rowsKnown && scanRows! > limits.maxScanRows) {
      reasons.push(
        `Estimated scan of ${fmt(scanRows!)} rows exceeds the limit of ${fmt(
          limits.maxScanRows,
        )} rows`,
      );
      want('block');
    }

    // 上限を設定した指標に未知値が 1 つでも含まれる場合は、既知テーブルの
    // 小計が得られていても全量とは扱わず ON_UNKNOWN を適用する。
    const incompleteDimensions: string[] = [];
    if (limits.maxScanBytes > 0 && (!bytesKnown || !scanBytesComplete)) {
      incompleteDimensions.push('bytes');
    }
    if (limits.maxScanRows > 0 && (!rowsKnown || !scanRowsComplete)) {
      incompleteDimensions.push('rows');
    }
    if (incompleteDimensions.length > 0 && limitsConfigured) {
      const decision = onUnknownDecision(limits.onUnknown);
      if (decision !== 'allow') {
        reasons.push(
          `Scan ${incompleteDimensions.join(' and ')} could not be fully estimated for this query`,
        );
        want(decision);
      }
    }
  }

  // 集めた要求の中で最も強い判定を採用する（何も要求が無ければ allow）。
  const requested = requests.reduce<GuardDecision>((acc, d) => worse(acc, d), 'allow');
  // warn モードでは block を要求されていても warn に格下げする
  // （warn モードは常に非破壊的な警告に留める）。
  const decision = limits.mode === 'warn' && requested === 'block' ? 'warn' : requested;
  return { decision, reasons };
}

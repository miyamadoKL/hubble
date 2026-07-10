/**
 * このファイルは Query Scheduling 機能の中核である `Scheduler` クラスを提供する。
 *
 * 保存済み SQL (Schedule) を cron 式に従って定期実行するインプロセスのスケジューラーで、
 * server 起動時に生成され、`tickSeconds` ごとに `tick()` を呼び出すタイマーを自前で持つ。
 * 各発火 (fire) では次の順で処理する:
 *   1. `validator.ts` (StatementValidator) で `EXPLAIN (TYPE VALIDATE)` による事前検証
 *   2. guardMode が `enforce` の場合、`EstimateService` で Query Guard のスキャン量見積り
 *   3. `execute.ts` (drainStatement) で実際に Trino へ投げて完走させる
 * 失敗時は `retry.ts` の分類 (deterministic/transient) に従い、transient のみ `retry.ts` の
 * 幾何バックオフで再試行する。実行結果 (成功/失敗/blocked/aborted) は `ScheduleRunRepository`
 * (store/schedules) を通じて `schedule_runs` テーブルへ永続化される。
 *
 * アーキテクチャ上の位置づけ: server の `services` 層に属し、`/api/schedules/*` の
 * ルートハンドラ (手動実行 `POST /api/schedules/:id/run` など) から利用される。
 * 次回発火時刻は常に「現在時刻」から計算する (`cron.ts` の `nextRunAfter`) ため、
 * サーバー停止中に発火時刻を跨いでも過去分は取り戻さず (バックフィルしない)、
 * 次の未来の発火だけを予約する。
 */
import type { ScheduleRunStatus } from '@hubble/contracts';
import type { TrinoRequestContext } from '../trino/types';
import type { EstimateService } from '../query/estimateService';
import type { QueryEngine } from '../engine/types';
import { getEngineOrUndefined } from '../engine/resolve';
import { hasQueryWrite, roleAllowsDatasource, schedulePrincipalIdentity } from '../rbac/check';
import { effectiveGuardLimits } from '../rbac/guard';
import { resolveRoleForPrincipal } from '../rbac/resolve';
import type { LoadedRbac } from '../rbac/types';
import { assertQueryWriteAllowed } from '../rbac/writeCheck';
import type { ServerConfig } from '../config';
import type { ScheduleRecord, ScheduleRepository, ScheduleRunRepository } from '../store/schedules';
import { drainStatement } from './execute';
import { nextRunAfter } from './cron';
import { backoffMs, classifyFailure, shouldRetry } from './retry';
import type { AuditJson, AuditLogger } from '../audit';
import type { FailureNotificationSender } from '../notification/service';

/**
 * Resolved scheduler settings.
 *
 * 日本語: server 起動時に config から解決される、スケジューラー動作パラメータ一式。
 */
export interface SchedulerConfig {
  // スケジューラーの tick ループ自体を起動するかどうか。false でも孤児実行の
  // 復旧 (abortOrphans) は行われる (start() 参照)。
  enabled: boolean;
  // tick() を呼び出す間隔（秒）。この間隔で全 enabled スケジュールを走査する。
  tickSeconds: number;
  // 同時に実行可能なスケジュール数の上限。tick() はこれを超えて新規発火しない。
  maxConcurrent: number;
  // schedule_runs テーブルに保持する実行履歴の最大件数（スケジュールごと）。
  runsRetention: number;
  /** `enforce` applies Query Guard blocking to scheduled runs. */
  // 日本語: 'off' は Query Guard を評価しない、'warn' は評価するが実行は妨げない、
  // 'enforce' はスキャン量見積りが閾値超過ならブロック (blocked ステータスで即終了) する。
  guardMode: 'off' | 'warn' | 'enforce';
}

// 日本語: Scheduler の構築に必要な依存一式 (DI)。テストでは now/sleep/setTimer を
// 差し替えることで時刻進行やバックオフ待ちを実時間なしに検証できる。
export interface SchedulerDeps {
  // schedule 定義 (cron 式、リトライポリシー等) の永続化リポジトリ。
  schedules: ScheduleRepository;
  // schedule_runs (実行履歴) の永続化リポジトリ。
  runs: ScheduleRunRepository;
  /** データソース id から QueryEngine を引くマップ。 */
  engines: Map<string, QueryEngine>;
  /** datasourceId 省略時の既定 id（スケジュールには永続化済み id を使う）。 */
  defaultDatasourceId: string;
  // Query Guard のスキャン量見積りサービス (enforce モードで使用)。
  estimate: EstimateService;
  /** 現在の RBAC 設定を返す getter（実行時ロール解決用）。 */
  getRbac: () => LoadedRbac;
  /** グローバル Guard 設定（ロール上書きのベース）。 */
  guardConfig: ServerConfig['guard'];
  /** スケジュール実行の監査ログ。 */
  audit?: AuditLogger;
  /** スケジュール失敗時の外部通知。 */
  notifications?: FailureNotificationSender;
  config: SchedulerConfig;
  /** Wall clock (injectable for tests). */
  // 日本語: 省略時は Date.now。テストでは仮想時計を注入して cron 発火判定を制御する。
  now?: () => number;
  /** Backoff sleep between retries (injectable for tests). */
  // 日本語: 省略時は実際に setTimeout で待つ。テストでは即時解決させて高速化する。
  sleep?: (ms: number) => Promise<void>;
  /** setTimeout shim returning a clearable handle (injectable for tests). */
  // 日本語: 省略時は Node の setTimeout。テストは vi.useFakeTimers 等と組み合わせて使う。
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/**
 * Terminal outcome of a single run (before persistence).
 *
 * 日本語: 1 回の実行 (リトライを含む一連の attempt) が確定した最終結果を表す内部型。
 * `executeRun` がこれを `ScheduleRunRepository.finish` へ渡して永続化する。
 */
interface RunOutcome {
  status: ScheduleRunStatus;
  // 使い切った試行回数 (成功/失敗いずれの確定でも、最後に試した attempt 番号)。
  attempt: number;
  trinoQueryId: string | null;
  errorType: string | null;
  errorMessage: string | null;
  rowCount: number | null;
  guard?: Record<string, AuditJson>;
}

// 日本語: SchedulerDeps.sleep 省略時の既定実装。実際に ms ミリ秒待ってから解決する。
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 日本語: SchedulerDeps.setTimer 省略時の既定実装。setTimeout をラップし、
// プロセス終了をタイマーが妨げないよう unref() できる場合は unref する。
function defaultSetTimer(fn: () => void, ms: number): { clear: () => void } {
  const handle = setTimeout(fn, ms);
  if (typeof handle === 'object' && 'unref' in handle) (handle as { unref: () => void }).unref();
  return { clear: () => clearTimeout(handle) };
}

/**
 * In-process query scheduler (Query Scheduling feature).
 *
 * A single tick loop scans enabled schedules every `tickSeconds`, fires any that
 * are due (next cron time has passed), and records a `schedule_runs` row per
 * firing. Each run validates the statement with `EXPLAIN (TYPE VALIDATE)` and
 * (in `enforce` guard mode) checks the scan estimate before executing; transient
 * failures retry per the schedule's policy, while deterministic failures
 * (USER_ERROR, guard block) fail immediately.
 *
 * Next-run times are computed from "now" (never backfilled), so a stopped server
 * skips missed fires and resumes at the next future occurrence. Overlap is
 * prevented per schedule, and total concurrency is capped by `maxConcurrent`.
 *
 * 日本語: ライフサイクルは start() → (tick() の繰り返し) → stop() の順。
 * start() はまずクラッシュ復旧 (実行中のまま残った run を aborted にする) を行い、
 * enabled なら次回発火時刻を seed して tick タイマーを起動する。tick() は
 * 期限が来たスケジュールを非同期に launch() し、overlap (同一スケジュールの多重実行)
 * と maxConcurrent (全体の同時実行数上限) の両方を守る。stop() はタイマーを止めた上で
 * 実行中の Promise 群を待ち合わせ、グレースフルに終了する。
 */
export class Scheduler {
  // 以下 3 つは SchedulerDeps から解決された実体 (省略時は defaultXxx にフォールバック)。
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => { clear: () => void };

  /** Next fire time (epoch ms) per schedule id, computed from "now". */
  // 日本語: スケジュール id ごとの「次に発火すべき時刻」。tick() のたびに現在時刻と比較し、
  // 過ぎていれば発火してこのマップを次の未来時刻へ更新する。
  private readonly nextFire = new Map<string, number>();
  /** Schedule ids with an in-flight run (overlap guard). */
  // 日本語: 実行中のスケジュール id 集合。同一スケジュールの多重発火 (overlap) を防ぐ。
  private readonly inFlight = new Set<string>();
  /** Promises for in-flight runs, awaited on shutdown. */
  // 日本語: stop()/whenIdle() が Promise.allSettled で待ち合わせるための実行中 Promise 群。
  private readonly running = new Map<string, Promise<void>>();

  // 日本語: 稼働中の tick タイマーのハンドル。stop() でこれを clear する。
  private tickHandle?: { clear: () => void };
  // 日本語: start() の多重呼び出しをガードする (冪等化)。
  private started = false;
  // 日本語: stop() 呼び出し後は true になり、以後 tick のスケジューリングを止める。
  private stopping = false;

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  setDefaultDatasourceId(id: string): void {
    this.deps.defaultDatasourceId = id;
  }

  /**
   * Recover crashed runs and start the tick loop. Safe to call when disabled
   * (recovery still runs; the loop does not start). Idempotent.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Crash recovery: any run left `running` from a previous process is aborted.
    // 日本語: 前回プロセスが実行途中でクラッシュ/強制終了した場合、running のまま
    // 残った schedule_runs 行を aborted へ確定させる。enabled に関わらず必ず行う。
    await this.deps.runs.abortOrphans(new Date(this.now()).toISOString());
    if (!this.deps.config.enabled) return;
    // 有効な全スケジュールの次回発火時刻を「現在時刻」基準で seed してから tick を起動する。
    await this.seedNextFires();
    this.scheduleTick();
  }

  /** Stop the tick loop and await any in-flight runs (graceful shutdown). */
  async stop(): Promise<void> {
    // 以後の tick 予約を止め、既存タイマーを解除する。
    this.stopping = true;
    this.tickHandle?.clear();
    this.tickHandle = undefined;
    // 実行中の run が完了 (成功でも失敗でも) するまで待ってから戻る。
    await Promise.allSettled([...this.running.values()]);
  }

  /** Await all currently in-flight runs to settle (no-op if idle). */
  async whenIdle(): Promise<void> {
    // 日本語: 主にテストから使う。実行中の全 run が終わるまで待機する。
    await Promise.allSettled([...this.running.values()]);
  }

  /** Number of schedules with an in-flight run (overlap/concurrency view). */
  get activeRuns(): number {
    return this.inFlight.size;
  }

  /** Seed `nextFire` for every enabled schedule from the current time. */
  private async seedNextFires(): Promise<void> {
    const now = new Date(this.now());
    const schedules = await this.deps.schedules.listAllEnabled();
    for (const s of schedules) {
      // 既に nextFire を持つスケジュールは上書きしない (start() の再入や tick 後の
      // 再呼び出しで既存の予約を壊さないため)。
      if (!this.nextFire.has(s.id)) {
        const next = nextRunAfter(s.cron, now);
        if (next !== null) this.nextFire.set(s.id, next);
      }
    }
  }

  // 日本語: tickSeconds 後に自身を呼び出す tick() を 1 回分だけ予約する
  // (setInterval ではなく setTimeout の再帰にすることで、tick() の実行時間が
  // 次回予約に影響しても間隔がズレるだけで重複発火はしない)。stopping なら何もしない。
  private scheduleTick(): void {
    if (this.stopping) return;
    this.tickHandle = this.setTimer(() => {
      void this.tick().finally(() => this.scheduleTick());
    }, this.deps.config.tickSeconds * 1000);
  }

  /**
   * One scan: fire every schedule whose next time has passed (subject to overlap
   * and concurrency limits). Exposed for tests to drive deterministically.
   */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    const schedules = await this.deps.schedules.listAllEnabled();
    const live = new Set(schedules.map((s) => s.id));
    // Forget schedules that were disabled/deleted since the last scan.
    // 日本語: 前回スキャン以降に無効化/削除されたスケジュールの予約時刻をここで破棄する
    // (メモリリーク防止、かつ再度有効化された際は下の「新規発火」扱いで再 seed される)。
    for (const id of this.nextFire.keys()) {
      if (!live.has(id)) this.nextFire.delete(id);
    }

    for (const schedule of schedules) {
      const fireAt = this.nextFire.get(schedule.id);
      if (fireAt === undefined) {
        // Newly enabled since startup: seed without firing immediately.
        // 日本語: 起動後に新規作成/有効化されたスケジュールは、いきなり発火させず
        // 次回発火時刻だけを現在時刻基準で予約する (最初の tick では走らない)。
        const next = nextRunAfter(schedule.cron, new Date(now));
        if (next !== null) this.nextFire.set(schedule.id, next);
        continue;
      }
      if (now < fireAt) continue;

      // Due. Advance the next fire time first so a long run can't double-fire,
      // then attempt to launch (respecting overlap + concurrency).
      // 日本語: 発火時刻に到達。実行を始める前に次回発火時刻を先に進めておくことで、
      // 実行が長引いても同じ枠で二重発火しないようにする。
      const scheduledFor = fireAt;
      const next = nextRunAfter(schedule.cron, new Date(now));
      if (next !== null) this.nextFire.set(schedule.id, next);
      else this.nextFire.delete(schedule.id);

      if (this.inFlight.has(schedule.id)) continue; // overlap: skip this fire
      if (this.inFlight.size >= this.deps.config.maxConcurrent) continue; // at cap

      // 日本語: overlap/上限チェックを通過した場合のみ実際に非同期実行を開始する。
      this.launch(schedule, new Date(scheduledFor).toISOString());
    }
  }

  /** Begin an async run, tracking it for overlap/shutdown bookkeeping. */
  private launch(schedule: ScheduleRecord, scheduledForIso: string): void {
    // 日本語: inFlight への追加は同期的に行い、tick() の次のイテレーションからも
    // 「実行中」として見えるようにする (overlap 判定の一貫性のため)。
    this.inFlight.add(schedule.id);
    const p = this.runOnce(schedule, scheduledForIso)
      .catch((err: unknown) => {
        // runOnce already persists outcomes; this guards an unexpected throw.
        // 日本語: 通常ここには来ない (executeRun は失敗も含めて必ず永続化するため)。
        // 想定外の例外がプロセスを落とさないための最後の砦としてログのみ出す。
        console.error(`scheduler: unexpected error running schedule ${schedule.id}`, err);
      })
      .finally(() => {
        // 成功/失敗いずれでも in-flight から外し、running から Promise を除去する。
        this.inFlight.delete(schedule.id);
        this.running.delete(schedule.id);
      });
    this.running.set(schedule.id, p);
  }

  /**
   * Manual run trigger (`POST /api/schedules/:id/run`). Uses the same execution
   * path and policy as the tick. Returns the run id, or throws if a run is
   * already in flight for this schedule. `scheduledFor` defaults to now.
   */
  async runManual(schedule: ScheduleRecord): Promise<{ runId: string }> {
    // 日本語: メモリ上の inFlight とDB上の hasRunning の両方をチェックする。
    // inFlight は同一プロセス内の重複を、hasRunning は (別プロセス由来なども含め)
    // DB 上に running 行が残っているケースを捕捉する二重の安全網。
    if (this.inFlight.has(schedule.id) || (await this.deps.runs.hasRunning(schedule.id))) {
      throw new Error('A run is already in progress for this schedule');
    }
    const scheduledForIso = new Date(this.now()).toISOString();
    this.inFlight.add(schedule.id);
    let runId: string;
    try {
      // 日本語: 先に schedule_runs へ running 状態の行を作る。ここで失敗したら
      // 実行を開始していないので inFlight を戻して例外を呼び出し元へ伝播する。
      runId = await this.deps.runs.start({
        scheduleId: schedule.id,
        owner: schedule.owner,
        scheduledFor: scheduledForIso,
        startedAt: scheduledForIso,
      });
    } catch (err) {
      this.inFlight.delete(schedule.id);
      throw err;
    }
    // Execute in the background; the route returns immediately with the run id.
    // 日本語: ルートハンドラは runId を待たずに即座にレスポンスを返すため、
    // 実際の検証、実行、リトライはここから非同期 (fire-and-forget) で進める。
    const p = this.executeRun(schedule, runId, scheduledForIso)
      .catch((err: unknown) => {
        console.error(`scheduler: unexpected error in manual run ${schedule.id}`, err);
      })
      .finally(() => {
        this.inFlight.delete(schedule.id);
        this.running.delete(schedule.id);
      });
    this.running.set(schedule.id, p);
    return { runId };
  }

  /** Insert the run row then execute (used by the tick path). */
  private async runOnce(schedule: ScheduleRecord, scheduledForIso: string): Promise<void> {
    // 日本語: tick 経路では overlap チェックは launch() 呼び出し前 (tick 内) で
    // 既に済んでいるため、ここでは schedule_runs 行の作成と実行のみを行う。
    const runId = await this.deps.runs.start({
      scheduleId: schedule.id,
      owner: schedule.owner,
      scheduledFor: scheduledForIso,
      startedAt: new Date(this.now()).toISOString(),
    });
    await this.executeRun(schedule, runId, scheduledForIso);
  }

  /**
   * Drive validation, guard, execution, and retries for a single run, then
   * persist the terminal outcome. Never throws (failures are recorded).
   */
  private async executeRun(
    schedule: ScheduleRecord,
    runId: string,
    scheduledForIso: string,
  ): Promise<void> {
    const startMs = this.now();
    // 検証〜実行〜リトライの全ループはここに委譲し、確定した最終結果 (RunOutcome) を受け取る。
    const outcome = await this.attemptWithRetries(schedule);
    const finishedMs = this.now();
    const elapsedMs = Math.max(finishedMs - startMs, 0);
    const finishedAt = new Date(finishedMs).toISOString();
    // 成功/失敗/blocked いずれの結果でも同じ finish() で確定させ、経過時間も記録する。
    await this.deps.runs.finish(runId, schedule.id, {
      status: outcome.status,
      attempt: outcome.attempt,
      trinoQueryId: outcome.trinoQueryId,
      errorType: outcome.errorType,
      errorMessage: outcome.errorMessage,
      rowCount: outcome.rowCount,
      elapsedMs,
      finishedAt,
    });
    await this.recordScheduleOutcome(schedule, runId, outcome, elapsedMs);
    if (outcome.status === 'failed') {
      // 通知送信はスケジュール実行の確定処理をブロックしない。
      void this.sendFailureNotification(schedule, runId, outcome, scheduledForIso, finishedAt);
    }
  }

  private async sendFailureNotification(
    schedule: ScheduleRecord,
    runId: string,
    outcome: RunOutcome,
    scheduledForIso: string,
    finishedAt: string,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      await this.deps.notifications.sendFailure({
        schedule,
        runId,
        errorType: outcome.errorType,
        errorMessage: outcome.errorMessage,
        scheduledFor: scheduledForIso,
        finishedAt,
      });
    } catch (err) {
      console.warn(`scheduler: notification failed for schedule ${schedule.id}`, err);
    }
  }

  private async recordScheduleOutcome(
    schedule: ScheduleRecord,
    runId: string,
    outcome: RunOutcome,
    elapsedMs: number,
  ): Promise<void> {
    if (!this.deps.audit) return;
    const detail: Record<string, AuditJson> = {
      scheduleId: schedule.id,
      runId,
      runOwner: schedule.owner,
      catalog: schedule.catalog ?? null,
      schema: schedule.schema ?? null,
      outcome: outcome.status,
      success: outcome.status === 'success',
      attempt: outcome.attempt,
      trinoQueryId: outcome.trinoQueryId,
      rowCount: outcome.rowCount,
      errorType: outcome.errorType,
      errorMessage: outcome.errorMessage,
      elapsedMs,
    };
    if (outcome.guard) detail.guard = outcome.guard;
    await this.deps.audit.record({
      actor: schedule.owner,
      action: 'schedule.execute',
      target: schedule.id,
      datasource: schedule.datasourceId,
      detail,
    });
  }

  /**
   * Run the validate -> guard -> execute pipeline with the schedule's retry
   * policy. Returns a terminal outcome; `attempt` is the number of attempts made.
   */
  private async attemptWithRetries(schedule: ScheduleRecord): Promise<RunOutcome> {
    const policy = schedule.retry;
    let attempt = 0;

    const engine = getEngineOrUndefined(this.deps.engines, schedule.datasourceId);
    if (!engine) {
      return {
        status: 'failed',
        attempt: 1,
        trinoQueryId: null,
        errorType: 'NOT_CONFIGURED',
        errorMessage: `Datasource '${schedule.datasourceId}' is not configured`,
        rowCount: null,
      };
    }

    const scheduleRole = resolveRoleForPrincipal(
      this.deps.getRbac(),
      schedulePrincipalIdentity(schedule.owner, schedule.principalSnapshot),
    );
    if (!roleAllowsDatasource(scheduleRole, schedule.datasourceId)) {
      return {
        status: 'blocked',
        attempt: 1,
        trinoQueryId: null,
        errorType: 'DATASOURCE_ACCESS_DENIED',
        errorMessage: `Datasource '${schedule.datasourceId}' is not allowed for this role`,
        rowCount: null,
      };
    }
    const releaseLease = engine.lease?.() ?? (() => {});
    try {
      const effective = effectiveGuardLimits(this.deps.guardConfig, scheduleRole);

      // 日本語: 無限ループに見えるが、各分岐は必ず return するか (確定的失敗/成功/blocked)、
      // maybeRetry() が undefined を返した場合のみ waitBeforeRetry() を挟んで continue する。
      // つまりループを抜けるのは「確定」か「リトライ上限到達で確定」のいずれかのみ。
      for (;;) {
        attempt += 1;

        try {
          const ioExplain = engine.ioExplainExecution?.({
            statement: schedule.statement,
            catalog: schedule.catalog ?? undefined,
            schema: schedule.schema ?? undefined,
            principal: schedule.owner,
          });
          await assertQueryWriteAllowed({
            statement: schedule.statement,
            role: scheduleRole,
            ioExplainClient: ioExplain?.client,
            ioExplainCtx: ioExplain?.ctx,
            ioExplainTimeoutMs: this.deps.guardConfig.estimateTimeoutMs,
          });
        } catch (err) {
          const errorType = errorTypeOf(err);
          const message = err instanceof Error ? err.message : String(err);
          return {
            status: 'failed',
            attempt,
            trinoQueryId: null,
            errorType,
            errorMessage: message,
            rowCount: null,
          };
        }

        // 1. Pre-flight validation (EXPLAIN VALIDATE). USER_ERROR is deterministic.
        // 日本語: 実行直前にもう一度 EXPLAIN (TYPE VALIDATE) で検証する。作成/更新時にも
        // 検証しているが、依存テーブルの変化などで実行時点では失敗しうるための再チェック。
        const validation = await engine.validate({
          statement: schedule.statement,
          catalog: schedule.catalog,
          schema: schedule.schema,
          principal: schedule.owner,
          roleName: scheduleRole.name,
        });
        if (!validation.ok && validation.kind === 'user_error') {
          // 日本語: SQL 自体が不正 (構文/意味エラー)。何度再試行しても同じ結果になるため
          // リトライせず即座に failed で確定する。
          return {
            status: 'failed',
            attempt,
            trinoQueryId: null,
            errorType: 'USER_ERROR',
            errorMessage: locationMessage(validation),
            rowCount: null,
          };
        }
        // `unavailable` validation (Trino unreachable) is a transient fault: fall
        // through to the catch via a thrown transport-style execution below — but
        // we can short-circuit and treat it as a transient failure directly.
        // 日本語: Trino に接続できない等、検証そのものが行えなかった場合は一時的な障害と
        // みなし、maybeRetry() でリトライ可否を判定してから待って再試行する。
        if (!validation.ok) {
          const transientOutcome = this.maybeRetry(
            attempt,
            policy,
            'TRINO_UNAVAILABLE',
            validation.message,
          );
          if (transientOutcome) return transientOutcome;
          await this.waitBeforeRetry(policy, attempt);
          continue;
        }

        // 2. Query Guard (enforce mode only): a block is deterministic.
        // 日本語: enforce モードでのみ、EXPLAIN (TYPE IO) ベースのスキャン量見積りを行い、
        // 閾値超過ならブロックする。ブロックはポリシー判断でありリトライしても結果は
        // 変わらないため、blocked ステータスで即座に確定する。
        if (effective.mode === 'enforce' && engine.capabilities.costEstimate) {
          const estimate = await this.deps.estimate.estimate({
            statement: schedule.statement,
            catalog: schedule.catalog ?? undefined,
            schema: schedule.schema ?? undefined,
            principal: schedule.owner,
            datasourceId: schedule.datasourceId,
            roleName: scheduleRole.name,
            guard: effective,
          });
          if (estimate.verdict.decision === 'block') {
            return {
              status: 'blocked',
              attempt,
              trinoQueryId: null,
              errorType: 'QUERY_BLOCKED',
              errorMessage: estimate.verdict.reasons.join('; ') || 'Blocked by Query Guard',
              rowCount: null,
              guard: {
                status: estimate.status,
                decision: estimate.verdict.decision,
                reasons: estimate.verdict.reasons,
                scanRows: estimate.scanRows,
                scanBytes: estimate.scanBytes,
                estimatedSeconds: estimate.estimatedSeconds,
                elapsedMs: estimate.elapsedMs,
              },
            };
          }
        }

        // 3. Execute.
        // 日本語: 検証とガードを通過したので実際に Trino へ投げ、完走 (全ページ追走) させる。
        // drainStatement は結果行をバッファせず行数だけ数える (execute.ts 参照)。
        try {
          const client = engine.executionClient({
            source: 'scheduled',
            user: schedule.owner,
            roleName: scheduleRole.name,
            sessionReadOnly: !hasQueryWrite(scheduleRole),
          });
          const ctx: TrinoRequestContext = {
            catalog: schedule.catalog ?? undefined,
            schema: schedule.schema ?? undefined,
            user: schedule.owner,
          };
          const result = await drainStatement(client, schedule.statement, ctx);
          return {
            status: 'success',
            attempt,
            trinoQueryId: result.trinoQueryId,
            errorType: null,
            errorMessage: null,
            rowCount: result.rowCount,
          };
        } catch (err) {
          // 日本語: retry.ts の classifyFailure で「再試行しても無駄 (deterministic)」か
          // 「一時的な障害 (transient)」かを判定する。
          const failureClass = classifyFailure(err);
          const errorType = errorTypeOf(err);
          const message = err instanceof Error ? err.message : String(err);
          if (failureClass === 'deterministic') {
            return {
              status: 'failed',
              attempt,
              trinoQueryId: null,
              errorType,
              errorMessage: message,
              rowCount: null,
            };
          }
          // transient: リトライ上限に達していなければ待って continue、達していれば
          // maybeRetry() が failed の RunOutcome を返すのでそれを確定させる。
          const transientOutcome = this.maybeRetry(attempt, policy, errorType, message);
          if (transientOutcome) return transientOutcome;
          await this.waitBeforeRetry(policy, attempt);
        }
      }
    } finally {
      releaseLease();
    }
  }

  /**
   * If no further retry is allowed after `attempt` attempts, return the final
   * `failed` outcome; otherwise return undefined (the caller waits + retries).
   */
  private maybeRetry(
    attempt: number,
    policy: ScheduleRecord['retry'],
    errorType: string | null,
    message: string,
  ): RunOutcome | undefined {
    // shouldRetry(policy, attempt) が true ならまだリトライ余地があるので undefined
    // (呼び出し元が待ってから continue する)。false なら上限到達なので failed で確定する。
    if (shouldRetry(policy, attempt)) return undefined;
    return {
      status: 'failed',
      attempt,
      trinoQueryId: null,
      errorType,
      errorMessage: message,
      rowCount: null,
    };
  }

  private async waitBeforeRetry(policy: ScheduleRecord['retry'], attempt: number): Promise<void> {
    // The upcoming retry index equals the number of attempts already made.
    // 日本語: retry.ts の backoffMs は 1-based の retryIndex を取る。ここまでの attempt 数が
    // そのまま「これから行うリトライの番号」になるため、そのまま渡してよい。
    await this.sleep(backoffMs(policy, attempt));
  }
}

/** Compose a USER_ERROR message with its line/column when present. */
// 日本語: バリデーションエラーのメッセージに、可能なら "(line N:M)" を付加して読みやすくする。
function locationMessage(v: { message: string; line?: number; column?: number }): string {
  if (v.line !== undefined && v.column !== undefined) {
    return `${v.message} (line ${v.line}:${v.column})`;
  }
  return v.message;
}

/** Best-effort Trino error type / code from a thrown error. */
// 日本語: エラーオブジェクトの形が実行時まで確定しないため、Trino 由来のエラー種別
// (trino.errorType) か AppError 由来のコード (detail.code) を緩く型ガードして取り出す。
// どちらも無ければ null (errorType 不明として記録される)。
function errorTypeOf(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const maybeTrino = err as { trino?: { errorType?: string }; detail?: { code?: string } };
    if (maybeTrino.trino?.errorType) return maybeTrino.trino.errorType;
    if (maybeTrino.detail?.code) return maybeTrino.detail.code;
  }
  return null;
}

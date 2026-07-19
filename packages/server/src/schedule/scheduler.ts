/**
 * このファイルは Query Scheduling 機能の中核である `Scheduler` クラスを提供する。
 *
 * 保存済み SQL (Schedule) を cron 式に従って定期実行するインプロセスのスケジューラーで、
 * server 起動時に生成される。`tickSeconds` ごとに `tick()` を呼び出すタイマー自体は
 * 自前で持たず `PeriodicRunner` (util/periodicRunner.ts) に委譲する。
 * 各発火 (fire) では次の順で処理する:
 *   1. `engine.validate()` で `EXPLAIN (TYPE VALIDATE)` による実行直前の事前検証
 *      (schedule 作成/更新時も `scheduleRoutes.ts` がルート側で `engine.validate()` を
 *      直接呼ぶ別経路で検証する)
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
 *
 * `workflow/runner.ts` と retry 実行部分の重複が大きいが、共通 executor へは
 * 抽出しない。engine lookup、RBAC、lease、write check、validate、guard、失敗分類、
 * backoff は重複していても、retry や abort の境界、lease の生存期間、失敗時の結果
 * capture と永続化は呼び出し側ごとに異なる。これらを一つの interface へ入れると
 * mode flag と caller 固有の分岐が増え、正味の削減が計測基準 (120 行) に届かない
 * ため、重複を許容してファイルを分離したまま維持する。
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
import {
  ScheduleRunClaimConflictError,
  type ScheduleRecord,
  type ScheduleRepository,
  type ScheduleRunRepository,
} from '../store/schedules';
import type { SavedQueryRepository } from '../store/savedQueries';
import { drainStatement } from './execute';
import { nextRunAfter } from './cron';
import { backoffMs, classifyFailure, retryPolicyForStatement, shouldRetry } from './retry';
import type { AuditJson, AuditLogger } from '../audit';
import type { FailureNotificationSender } from '../notification/service';
import {
  JobAdmissionRejectedError,
  type JobAdmissionController,
  type JobAdmissionLease,
} from './admission';
import { PeriodicRunner } from '../util/periodicRunner';
import { raceSqlAbort } from '../engine/sql/abort';

/**
 * server 起動時に config から解決される、スケジューラー動作パラメータ一式。
 */
export interface SchedulerConfig {
  // スケジューラーの tick ループ自体を起動するかどうか。false でも孤児実行の
  // 復旧 (abortOrphans) は行われる (start() 参照)。
  enabled: boolean;
  // tick() を呼び出す間隔（秒）。この間隔で全 enabled スケジュールを走査する。
  tickSeconds: number;
  // schedule、workflow、alert が共有する同時実行上限。services 層はこの値から
  // 共有 admission controller (JobAdmissionController) を1つ構築し、tick() 自身では
  // なく tryAcquire() の呼び出し側 (launch()/runManual()) がこの上限を強制する。
  maxConcurrent: number;
  // schedule_runs テーブルに保持する実行履歴の最大件数（スケジュールごと）。
  runsRetention: number;
  // 'off' は Query Guard を評価しない、'warn' は評価するが実行は妨げない、
  // 'enforce' はスキャン量見積りが閾値超過ならブロック (blocked ステータスで即終了) する。
  guardMode: 'off' | 'warn' | 'enforce';
}

// Scheduler の構築に必要な依存一式 (DI)。テストでは now/sleep/setTimer を
// 差し替えることで時刻進行やバックオフ待ちを実時間なしに検証できる。
export interface SchedulerDeps {
  // schedule 定義 (cron 式、リトライポリシー等) の永続化リポジトリ。
  schedules: ScheduleRepository;
  // schedule_runs (実行履歴) の永続化リポジトリ。
  runs: ScheduleRunRepository;
  /**
   * 保存済みクエリの永続化リポジトリ。savedQueryId を参照する schedule は、
   * 実行のたびに (attemptWithRetries の冒頭で) ここから現在の statement を
   * 解決する。保存時に解決した statement をキャッシュして使い回すことはしない
   * (saved query の編集が次回実行に反映されるのが仕様)。
   */
  savedQueries: SavedQueryRepository;
  /** データソース id から QueryEngine を引くマップ。 */
  engines: Map<string, QueryEngine>;
  /** 解決した saved query が datasourceId を持たない場合に使う既定 id。 */
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
  /** schedule、workflow、alert で共有する実行枠。 */
  admission: JobAdmissionController;
  config: SchedulerConfig;
  // 省略時は Date.now。テストでは仮想時計を注入して cron 発火判定を制御する。
  now?: () => number;
  // 省略時は実際に setTimeout で待つ。テストでは即時解決させて高速化する。
  sleep?: (ms: number) => Promise<void>;
  // 省略時は Node の setTimeout。テストは vi.useFakeTimers 等と組み合わせて使う。
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/**
 * 1 回の実行 (リトライを含む一連の attempt) が確定した最終結果を表す内部型。
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
  // 実行のたびに saved query から解決した実行先データソース id。
  // principal snapshot 欠如など、解決前に確定した outcome では null。
  datasourceId: string | null;
}

// SchedulerDeps.sleep 省略時の既定実装。実際に ms ミリ秒待ってから解決する。
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// SchedulerDeps.setTimer 省略時の setTimeout と unref は PeriodicRunner が共通実装する。

/**
 * インプロセスのクエリスケジューラー (Query Scheduling 機能)。
 *
 * `tickSeconds` ごとに tick ループが有効なスケジュールを走査し、次回発火時刻を
 * 過ぎたものを発火させて `schedule_runs` 行を記録する。各 run は
 * `EXPLAIN (TYPE VALIDATE)` による事前検証を行い、`enforce` guard モードでは
 * 実行前にスキャン量見積りも確認する。transient な失敗はスケジュールのポリシーに
 * 従って再試行し、deterministic な失敗 (USER_ERROR、guard block) は即座に確定する。
 *
 * 次回発火時刻は常に現在時刻から計算し (バックフィルしない)、停止していたサーバーは
 * 取りこぼした発火を無視して次の未来の発火だけを再開する。同一スケジュールの多重実行
 * (overlap) の防止と、schedule/workflow/alert 全体での同時実行数の上限
 * (`maxConcurrent`) は共有 admission controller が担う。
 *
 * ライフサイクルは start() → (tick() の繰り返し) → stop() の順。start() はまず
 * クラッシュ復旧 (実行中のまま残った run を aborted にする) を行い、enabled なら
 * 次回発火時刻を seed して tick タイマーを起動する。tick() は期限が来たスケジュールを
 * 非同期に launch() する。stop() はタイマーを止めた上で実行中の Promise 群を
 * 待ち合わせ、グレースフルに終了する。
 */
export class Scheduler {
  // 以下は SchedulerDeps から解決された実体 (省略時は defaultXxx にフォールバック)。
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly periodic: PeriodicRunner;
  private readonly shutdownAbort = new AbortController();

  // スケジュール id ごとの「次に発火すべき時刻」(epoch ms、現在時刻基準で計算)。
  // tick() のたびに現在時刻と比較し、過ぎていれば発火してこのマップを
  // 次の未来時刻へ更新する。
  private readonly nextFire = new Map<string, number>();
  // 実行中のスケジュール id 集合。同一スケジュールの多重発火 (overlap) を防ぐ。
  private readonly inFlight = new Set<string>();
  // stop()/whenIdle() が Promise.allSettled で待ち合わせるための実行中 Promise 群。
  private readonly running = new Map<string, Promise<void>>();
  private readonly starting = new Set<Promise<void>>();
  private readonly notificationTasks = new Set<Promise<void>>();

  // 稼働中の tick timer と task は PeriodicRunner が保持し、stop() で停止して待つ。
  // start() の多重呼び出しをガードする (冪等化)。
  private started = false;
  // stop() 呼び出し後は true になり、以後 tick のスケジューリングを止める。
  private stopping = false;

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.periodic = new PeriodicRunner({
      intervalMs: deps.config.tickSeconds * 1_000,
      task: () => this.tick(),
      logError: (message, error) => console.error(message, error),
      errorMessage: 'scheduler: periodic tick failed',
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    });
  }

  setDefaultDatasourceId(id: string): void {
    this.deps.defaultDatasourceId = id;
  }

  /**
   * クラッシュした run を復旧してから tick ループを開始する。disabled のときも
   * 復旧処理だけは実行し (ループは起動しない)、複数回呼んでも安全 (冪等)。
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 前回プロセスが実行途中でクラッシュ/強制終了した場合、running のまま
    // 残った schedule_runs 行を aborted へ確定させる。enabled に関わらず必ず行う。
    await this.deps.runs.abortOrphans(new Date(this.now()).toISOString());
    if (!this.deps.config.enabled) return;
    // 有効な全スケジュールの次回発火時刻を「現在時刻」基準で seed してから tick を起動する。
    await this.seedNextFires();
    this.periodic.start();
  }

  /** tick ループを停止し、実行中の run を待ち合わせてグレースフルに終了する。 */
  async stop(): Promise<void> {
    // 以後の tick 予約を止め、既存タイマーを解除する。
    this.stopping = true;
    this.shutdownAbort.abort();
    await this.periodic.stop();
    // claim 中、実行中、通知中の task がすべて無くなるまで待ってから戻る。
    await this.drainLifecycleTasks();
  }

  /** 主にテストから使う。claim、実行、通知がすべて終わるまで待機する (idle なら即座に戻る)。 */
  async whenIdle(): Promise<void> {
    await this.drainLifecycleTasks();
  }

  /** overlap/同時実行数の観点での、実行中スケジュール数。 */
  get activeRuns(): number {
    return this.inFlight.size;
  }

  /** 有効な全スケジュールについて、現在時刻を基準に `nextFire` を seed する。 */
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

  // tick ループの駆動は PeriodicRunner (util/periodicRunner.ts) に委譲している。
  // setInterval ではなく、tick 完了後に次の setTimeout を予約する方式のため、
  // tick() の実行時間が長引いても間隔が後ろへずれるだけで、同じ処理が
  // 重複発火することはない。

  /**
   * 1 回分のスキャン。次回発火時刻を過ぎた全スケジュールを (overlap と同時実行数の
   * 上限に従って) 発火させる。テストから決定的に駆動できるよう公開している。
   */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    const schedules = await this.deps.schedules.listAllEnabled();
    const live = new Set(schedules.map((s) => s.id));
    // 前回スキャン以降に無効化/削除されたスケジュールの予約時刻をここで破棄する
    // (メモリリーク防止、かつ再度有効化された際は下の「新規発火」扱いで再 seed される)。
    for (const id of this.nextFire.keys()) {
      if (!live.has(id)) this.nextFire.delete(id);
    }

    for (const schedule of schedules) {
      const fireAt = this.nextFire.get(schedule.id);
      if (fireAt === undefined) {
        // 起動後に新規作成/有効化されたスケジュールは、いきなり発火させず
        // 次回発火時刻だけを現在時刻基準で予約する (最初の tick では走らない)。
        const next = nextRunAfter(schedule.cron, new Date(now));
        if (next !== null) this.nextFire.set(schedule.id, next);
        continue;
      }
      if (now < fireAt) continue;

      // 発火時刻に到達。実行を始める前に次回発火時刻を先に進めておくことで、
      // 実行が長引いても同じ枠で二重発火しないようにする。
      const scheduledFor = fireAt;
      const next = nextRunAfter(schedule.cron, new Date(now));
      if (next !== null) this.nextFire.set(schedule.id, next);
      else this.nextFire.delete(schedule.id);

      let lease: JobAdmissionLease;
      try {
        lease = this.deps.admission.tryAcquire('schedule', schedule.id);
      } catch (err) {
        if (err instanceof JobAdmissionRejectedError) continue;
        throw err;
      }

      // overlap/上限チェックを通過した場合のみ実際に非同期実行を開始する。
      this.launch(schedule, new Date(scheduledFor).toISOString(), lease);
    }
  }

  /** 非同期 run を開始し、重複防止と停止待機のため追跡する。 */
  private launch(
    schedule: ScheduleRecord,
    scheduledForIso: string,
    admissionLease: JobAdmissionLease,
  ): void {
    // inFlight への追加は同期的に行い、tick() の次のイテレーションからも
    // 「実行中」として見えるようにする (overlap 判定の一貫性のため)。
    this.inFlight.add(schedule.id);
    const p = this.runOnce(schedule, scheduledForIso)
      .catch((err: unknown) => {
        // 通常ここには来ない (executeRun は失敗も含めて必ず永続化するため)。
        // 想定外の例外がプロセスを落とさないための最後の砦としてログのみ出す。
        console.error(`scheduler: unexpected error running schedule ${schedule.id}`, err);
      })
      .finally(() => {
        // 成功/失敗いずれでも in-flight から外し、running から Promise を除去する。
        this.inFlight.delete(schedule.id);
        this.running.delete(schedule.id);
        admissionLease.release();
      });
    this.running.set(schedule.id, p);
  }

  /**
   * 手動 run トリガー (`POST /api/schedules/:id/run`)。cron 発火と同じ実行経路と
   * ポリシーを使う。run id を返し、同一定義に対する run が既に進行中なら例外を
   * 投げる。`scheduledFor` は既定で現在時刻になる。
   */
  async runManual(schedule: ScheduleRecord): Promise<{ runId: string }> {
    // まず共有 admission (schedule/admission.ts) から実行枠を取得し、同一プロセス内の
    // 重複と全体上限を判定する。その後の runs.start() が DB 側で running 行の claim に
    // 失敗した場合 (別プロセス由来などで既に running 行が存在する場合) は
    // ScheduleRunClaimConflictError を投げてくるため、catch 節で
    // JobAdmissionRejectedError('duplicate', ...) へ変換し、admission 側の重複判定と
    // 同じエラー型として呼び出し元へ伝える。
    const admissionLease = this.deps.admission.tryAcquire('schedule', schedule.id);
    const scheduledForIso = new Date(this.now()).toISOString();
    this.inFlight.add(schedule.id);
    let finishStarting!: () => void;
    const starting = new Promise<void>((resolve) => {
      finishStarting = resolve;
    });
    this.starting.add(starting);
    try {
      // 先に schedule_runs へ running 状態の行を作る。ここで失敗したら
      // 実行を開始していないので inFlight を戻して例外を呼び出し元へ伝播する。
      const runId = await this.deps.runs.start({
        scheduleId: schedule.id,
        owner: schedule.owner,
        scheduledFor: scheduledForIso,
        startedAt: scheduledForIso,
      });
      // ルートハンドラは runId を待たずに即座にレスポンスを返すため、
      // 実際の検証、実行、リトライはここから非同期 (fire-and-forget) で進める。
      const p = this.executeRun(schedule, runId, scheduledForIso)
        .catch((err: unknown) => {
          console.error(`scheduler: unexpected error in manual run ${schedule.id}`, err);
        })
        .finally(() => {
          this.inFlight.delete(schedule.id);
          this.running.delete(schedule.id);
          admissionLease.release();
        });
      this.running.set(schedule.id, p);
      return { runId };
    } catch (err) {
      this.inFlight.delete(schedule.id);
      admissionLease.release();
      if (err instanceof ScheduleRunClaimConflictError) {
        throw new JobAdmissionRejectedError('duplicate', 'schedule', schedule.id);
      }
      throw err;
    } finally {
      this.starting.delete(starting);
      finishStarting();
    }
  }

  /** cron 経路で running 行を claim してから実行する。 */
  private async runOnce(schedule: ScheduleRecord, scheduledForIso: string): Promise<void> {
    // tick 経路では overlap チェックは launch() 呼び出し前 (tick 内) で
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
   * 1 回分の run について検証、guard、実行、リトライを駆動し、最終結果を永続化する。
   * 例外は投げない (失敗は結果として記録される)。
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
      this.trackNotificationTask(
        this.sendFailureNotification(schedule, runId, outcome, scheduledForIso, finishedAt),
      );
    }
  }

  private trackNotificationTask(task: Promise<void>): void {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.notificationTasks.add(tracked);
    void tracked.then(() => this.notificationTasks.delete(tracked));
  }

  private async drainLifecycleTasks(): Promise<void> {
    for (;;) {
      const tasks = [...this.starting, ...this.running.values(), ...this.notificationTasks];
      if (tasks.length === 0) return;
      await Promise.allSettled(tasks);
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
        datasourceId: outcome.datasourceId,
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
      savedQueryId: schedule.savedQueryId,
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
      ...(outcome.datasourceId !== null ? { datasource: outcome.datasourceId } : {}),
      detail,
    });
  }

  /** 検証、guard、実行を安全な実効リトライポリシーで繰り返し、終端結果を返す。 */
  private async attemptWithRetries(schedule: ScheduleRecord): Promise<RunOutcome> {
    let attempt = 0;

    if (!schedule.principalSnapshot) {
      return {
        status: 'blocked',
        attempt: 1,
        trinoQueryId: null,
        errorType: 'PRINCIPAL_SNAPSHOT_REQUIRED',
        errorMessage: `Schedule '${schedule.id}' cannot execute without a principal snapshot`,
        rowCount: null,
        datasourceId: null,
      };
    }

    const scheduleIdentity = schedulePrincipalIdentity(schedule.owner, schedule.principalSnapshot);
    const scheduleRole = resolveRoleForPrincipal(this.deps.getRbac(), scheduleIdentity);

    // 実行のたびに saved query を解決する。statement / catalog / schema / 実行先
    // データソースはすべて saved query 側が持つ値を毎回 savedQueries.get() で
    // 取得し (保存時のキャッシュは使わない)、以後の write check / validate /
    // guard 見積り / 実行はすべてこの解決済みの値に対して行う。これにより
    // saved query 側の編集が次回実行へ即座に反映される。
    const savedQuery = await this.deps.savedQueries.get(
      {
        user: schedule.owner,
        groups: schedule.principalSnapshot.groups ?? [],
        role: scheduleRole.name,
      },
      schedule.savedQueryId,
    );
    if (!savedQuery) {
      return {
        status: 'failed',
        attempt: 1,
        trinoQueryId: null,
        errorType: 'SAVED_QUERY_ACCESS_DENIED',
        errorMessage: `Saved query '${schedule.savedQueryId}' is not accessible to the schedule owner`,
        rowCount: null,
        datasourceId: null,
      };
    }
    const statement = savedQuery.statement;
    const catalog = savedQuery.catalog ?? null;
    const schema = savedQuery.schema ?? null;
    // saved query が実行先を指定していなければ既定データソースへフォールバックする。
    const datasourceId = savedQuery.datasourceId ?? this.deps.defaultDatasourceId;

    const engine = getEngineOrUndefined(this.deps.engines, datasourceId);
    if (!engine) {
      return {
        status: 'failed',
        attempt: 1,
        trinoQueryId: null,
        errorType: 'NOT_CONFIGURED',
        errorMessage: `Datasource '${datasourceId}' is not configured`,
        rowCount: null,
        datasourceId,
      };
    }

    if (!roleAllowsDatasource(scheduleRole, datasourceId)) {
      return {
        status: 'blocked',
        attempt: 1,
        trinoQueryId: null,
        errorType: 'DATASOURCE_ACCESS_DENIED',
        errorMessage: `Datasource '${datasourceId}' is not allowed for this role`,
        rowCount: null,
        datasourceId,
      };
    }

    const policy = retryPolicyForStatement(schedule.retry, statement);
    const releaseLease = engine.lease?.() ?? (() => {});
    try {
      const effective = effectiveGuardLimits(this.deps.guardConfig, scheduleRole);

      // 無限ループに見えるが、各分岐は必ず return するか (確定的失敗/成功/blocked)、
      // maybeRetry() が undefined を返した場合のみ waitBeforeRetry() を挟んで continue する。
      // つまりループを抜けるのは「確定」か「リトライ上限到達で確定」のいずれかのみ。
      for (;;) {
        if (this.shutdownAbort.signal.aborted) return this.abortedOutcome(attempt, datasourceId);
        attempt += 1;

        try {
          const ioExplain = engine.ioExplainExecution?.({
            statement,
            catalog: catalog ?? undefined,
            schema: schema ?? undefined,
            principal: schedule.owner,
          });
          await assertQueryWriteAllowed({
            statement,
            role: scheduleRole,
            ioExplainClient: ioExplain?.client,
            ioExplainCtx: ioExplain?.ctx,
            ioExplainTimeoutMs: this.deps.guardConfig.estimateTimeoutMs,
          });
        } catch (err) {
          if (this.shutdownAbort.signal.aborted) return this.abortedOutcome(attempt, datasourceId);
          const errorType = errorTypeOf(err);
          const message = err instanceof Error ? err.message : String(err);
          return {
            status: 'failed',
            attempt,
            trinoQueryId: null,
            errorType,
            errorMessage: message,
            rowCount: null,
            datasourceId,
          };
        }

        // 実行直前にもう一度 EXPLAIN (TYPE VALIDATE) で検証する。作成/更新時にも
        // 検証しているが、依存テーブルの変化などで実行時点では失敗しうるための再チェック。
        const validation = await engine.validate({
          statement,
          catalog,
          schema,
          principal: schedule.owner,
          roleName: scheduleRole.name,
        });
        if (!validation.ok && validation.kind === 'user_error') {
          // SQL 自体が不正 (構文/意味エラー)。何度再試行しても同じ結果になるため
          // リトライせず即座に failed で確定する。
          return {
            status: 'failed',
            attempt,
            trinoQueryId: null,
            errorType: 'USER_ERROR',
            errorMessage: locationMessage(validation),
            rowCount: null,
            datasourceId,
          };
        }
        // Trino に接続できない等、検証そのものが行えなかった場合は一時的な障害と
        // みなし、maybeRetry() でリトライ可否を判定してから待って再試行する。
        if (!validation.ok) {
          const transientOutcome = this.maybeRetry(
            attempt,
            policy,
            'TRINO_UNAVAILABLE',
            validation.message,
            datasourceId,
          );
          if (transientOutcome) return transientOutcome;
          await this.waitBeforeRetry(policy, attempt);
          continue;
        }

        // enforce モードでのみ、EXPLAIN (TYPE IO) ベースのスキャン量見積りを行い、
        // 閾値超過ならブロックする。ブロックはポリシー判断でありリトライしても結果は
        // 変わらないため、blocked ステータスで即座に確定する。
        if (effective.mode === 'enforce' && engine.capabilities.costEstimate) {
          const estimate = await this.deps.estimate.estimate({
            statement,
            catalog: catalog ?? undefined,
            schema: schema ?? undefined,
            principal: schedule.owner,
            datasourceId,
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
              datasourceId,
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

        // 検証とガードを通過したので実際に Trino へ投げ、完走 (全ページ追走) させる。
        // drainStatement は結果行をバッファせず行数だけ数える (execute.ts 参照)。
        try {
          const client = engine.executionClient({
            source: 'scheduled',
            user: schedule.owner,
            roleName: scheduleRole.name,
            sessionReadOnly: !hasQueryWrite(scheduleRole),
          });
          const ctx: TrinoRequestContext = {
            catalog: catalog ?? undefined,
            schema: schema ?? undefined,
            user: schedule.owner,
          };
          const result = await drainStatement(client, statement, ctx, {
            signal: this.shutdownAbort.signal,
          });
          return {
            status: 'success',
            attempt,
            trinoQueryId: result.trinoQueryId,
            errorType: null,
            errorMessage: null,
            rowCount: result.rowCount,
            datasourceId,
          };
        } catch (err) {
          if (this.shutdownAbort.signal.aborted) return this.abortedOutcome(attempt, datasourceId);
          // retry.ts の classifyFailure で「再試行しても無駄 (deterministic)」か
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
              datasourceId,
            };
          }
          // transient: リトライ上限に達していなければ待って continue、達していれば
          // maybeRetry() が failed の RunOutcome を返すのでそれを確定させる。
          const transientOutcome = this.maybeRetry(
            attempt,
            policy,
            errorType,
            message,
            datasourceId,
          );
          if (transientOutcome) return transientOutcome;
          await this.waitBeforeRetry(policy, attempt);
        }
      }
    } catch (err) {
      if (this.shutdownAbort.signal.aborted) return this.abortedOutcome(attempt, datasourceId);
      throw err;
    } finally {
      releaseLease();
    }
  }

  /**
   * `attempt` 回の試行後にこれ以上リトライできない場合は最終的な `failed` outcome を
   * 返す。まだリトライできる場合は undefined を返す (呼び出し元が待機して再試行する)。
   */
  private maybeRetry(
    attempt: number,
    policy: ScheduleRecord['retry'],
    errorType: string | null,
    message: string,
    datasourceId: string,
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
      datasourceId,
    };
  }

  private async waitBeforeRetry(policy: ScheduleRecord['retry'], attempt: number): Promise<void> {
    // retry.ts の backoffMs は 1-based の retryIndex を取る。ここまでの attempt 数が
    // そのまま「これから行うリトライの番号」になるため、そのまま渡してよい。
    await raceSqlAbort(this.sleep(backoffMs(policy, attempt)), this.shutdownAbort.signal);
  }

  private abortedOutcome(attempt: number, datasourceId: string | null = null): RunOutcome {
    return {
      status: 'aborted',
      attempt: Math.max(attempt, 1),
      trinoQueryId: null,
      errorType: 'SERVER_SHUTDOWN',
      errorMessage: 'Run aborted during server shutdown',
      rowCount: null,
      datasourceId,
    };
  }
}

// バリデーションエラーのメッセージに、可能なら "(line N:M)" を付加して読みやすくする。
function locationMessage(v: { message: string; line?: number; column?: number }): string {
  if (v.line !== undefined && v.column !== undefined) {
    return `${v.message} (line ${v.line}:${v.column})`;
  }
  return v.message;
}

// エラーオブジェクトの形が実行時まで確定しないため、Trino 由来のエラー種別
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

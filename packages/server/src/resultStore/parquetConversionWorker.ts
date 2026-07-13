/**
 * durable Parquet 変換 job を単一プロセス内で直列処理する worker。
 *
 * DB に running 状態を保存しないため、変換中にプロセスが終了しても job は
 * pending のまま残る。再起動時に source link と期限を再検証してから処理する。
 */
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { HistoryRepository, HistoryResultRef } from '../store/history';
import {
  RESULT_PARQUET_CONVERSION_ENCODING_VERSION,
  type ResultParquetConversionJob,
  type ResultParquetConversionJobRepository,
} from '../store/resultParquetConversionJobs';
import { cleanupUnlinkedResultObject, type ResultObjectDeletionQueue } from './objectCleanup';
import {
  convertJsonlToParquet,
  ParquetConverterError,
  type ParquetConverterResourceLimits,
} from './parquetConverter';
import type { ResultStore } from './store';
import { PeriodicRunner } from '../util/periodicRunner';

const CLAIM_LIMIT = 10;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000;

/** Parquet 変換 worker の実行設定。concurrency は常に 1 で固定する。 */
export interface ParquetConversionWorkerConfig {
  intervalMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  deadRetentionMs?: number;
  resourceLimits?: ParquetConverterResourceLimits;
}

export interface ParquetConversionWorkerDeps {
  jobs: ResultParquetConversionJobRepository;
  history: HistoryRepository;
  resultStore: ResultStore;
  resultObjectDeletions: ResultObjectDeletionQueue;
  config?: ParquetConversionWorkerConfig;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
  logWarn?: (message: string, error?: unknown) => void;
  converter?: typeof convertJsonlToParquet;
}

/** Parquet artifact を作成し、履歴 link を最後に確定する worker。 */
export class ParquetConversionWorker {
  private readonly now: () => number;
  private readonly logWarn: (message: string, error?: unknown) => void;
  private readonly config: Required<
    Pick<
      ParquetConversionWorkerConfig,
      'intervalMs' | 'maxAttempts' | 'backoffMs' | 'deadRetentionMs'
    >
  > &
    Pick<ParquetConversionWorkerConfig, 'resourceLimits'>;
  private readonly converter: typeof convertJsonlToParquet;
  private readonly periodic: PeriodicRunner;
  private running?: Promise<void>;
  private activeAbort?: AbortController;
  private stopping = false;

  constructor(private readonly deps: ParquetConversionWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.logWarn = deps.logWarn ?? ((message, error) => console.warn(message, error));
    this.config = {
      intervalMs: deps.config?.intervalMs ?? DEFAULT_INTERVAL_MS,
      maxAttempts: deps.config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffMs: deps.config?.backoffMs ?? DEFAULT_BACKOFF_MS,
      deadRetentionMs: deps.config?.deadRetentionMs ?? DEFAULT_DEAD_RETENTION_MS,
      resourceLimits: deps.config?.resourceLimits,
    };
    this.converter = deps.converter ?? convertJsonlToParquet;
    this.periodic = new PeriodicRunner({
      intervalMs: this.config.intervalMs,
      task: () => this.tick(),
      logError: (message, error) => this.logWarn(message, error),
      errorMessage: 'result parquet conversion: periodic tick failed',
      runImmediately: true,
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    });
  }

  /** 起動時に replay を行い、その後は due job を周期的に処理する。 */
  start(): void {
    if (!this.deps.resultStore.enabled) return;
    this.periodic.start();
  }

  /** 新規 tick と timer を止め、変換中なら abort して終了を待つ。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.activeAbort?.abort();
    await this.periodic.stop();
    await this.running;
  }

  /** due job を一回処理する。重複呼び出しは同じ Promise を待つ。 */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const running = this.runTick().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async runTick(): Promise<void> {
    if (!this.deps.resultStore.enabled || this.stopping) return;
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const jobs = await this.deps.jobs.claimDue(nowIso, CLAIM_LIMIT);
    for (const job of jobs) {
      if (this.stopping) return;
      await this.process(job);
    }
    await this.deps.jobs.pruneDead(
      new Date(nowMs - this.config.deadRetentionMs).toISOString(),
      CLAIM_LIMIT,
    );
  }

  private async process(job: ResultParquetConversionJob): Promise<void> {
    const ref = await this.deps.history.getResultRefById(job.historyId);
    const decision = await this.revalidate(job, ref);
    if (decision === 'complete' || decision === 'obsolete' || decision === 'dead') return;

    const controller = new AbortController();
    this.activeAbort = controller;
    let processingError: unknown;
    let tempDirectory: string | undefined;
    let sourceStream: Readable | undefined;
    try {
      tempDirectory = await mkdtemp(join(tmpdir(), 'hubble-parquet-job-'));
      const outputPath = join(tempDirectory, 'result.parquet');
      sourceStream = await this.deps.resultStore.getStream(job.sourceObjectKey);
      if (controller.signal.aborted) {
        sourceStream.destroy();
        throw new ParquetConverterError('aborted', 'Parquet conversion worker stopped');
      }
      await this.converter({
        source: sourceStream,
        sourceFormat: ref!.format!,
        columns: ref!.columns!,
        expectedRowCount: ref!.rowCount,
        outputPath,
        resourceLimits: this.config.resourceLimits,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw new ParquetConverterError('aborted', 'Parquet conversion worker stopped');
      }
      const output = createReadStream(outputPath);
      controller.signal.addEventListener('abort', () => output.destroy(), { once: true });
      await this.deps.resultStore.put(job.targetObjectKey, output, 'parquet');
      if (controller.signal.aborted) {
        throw new ParquetConverterError('aborted', 'Parquet conversion worker stopped');
      }
      const linked = await this.deps.history.setParquetObject(
        job.historyId,
        job.sourceObjectKey,
        job.targetObjectKey,
        job.encodingVersion || RESULT_PARQUET_CONVERSION_ENCODING_VERSION,
      );
      if (!linked) {
        await cleanupUnlinkedResultObject(job.targetObjectKey, {
          store: this.deps.resultStore,
          deletions: this.deps.resultObjectDeletions,
          now: this.now,
          logWarn: this.logWarn,
        });
      }
      await this.deps.jobs.markComplete(job.historyId, new Date(this.now()).toISOString());
    } catch (error) {
      processingError = error;
      // 前回プロセスが upload 後に終了して残した stale target も含めて確認する。
      // live history reference があれば cleanupUnlinkedResultObject が保持する。
      await cleanupUnlinkedResultObject(job.targetObjectKey, {
        store: this.deps.resultStore,
        deletions: this.deps.resultObjectDeletions,
        now: this.now,
        logWarn: this.logWarn,
      });
    } finally {
      sourceStream?.destroy();
      try {
        if (tempDirectory !== undefined) await rm(tempDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        if (processingError === undefined) processingError = cleanupError;
        else this.logWarn(`failed to remove Parquet conversion temp directory`, cleanupError);
      }
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
    if (processingError !== undefined) {
      await this.recordFailure(job, processingError, controller.signal);
    }
  }

  private async revalidate(
    job: ResultParquetConversionJob,
    ref: HistoryResultRef | undefined,
  ): Promise<'convert' | 'complete' | 'obsolete' | 'dead'> {
    const nowIso = new Date(this.now()).toISOString();
    if (!ref) {
      await this.deps.jobs.markObsolete(
        job.historyId,
        'history_unlinked',
        'History row has no live JSONL result link',
        nowIso,
      );
      return 'obsolete';
    }
    if (ref.resultObjectKey !== job.sourceObjectKey) {
      await this.deps.jobs.markObsolete(
        job.historyId,
        'source_changed',
        `History source object changed: ${ref.resultObjectKey}`,
        nowIso,
      );
      return 'obsolete';
    }
    if (ref.state !== 'finished') {
      await this.deps.jobs.markObsolete(
        job.historyId,
        'history_not_finished',
        `History state is not finished: ${ref.state}`,
        nowIso,
      );
      return 'obsolete';
    }
    const expiresAtMs = new Date(ref.resultExpiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      await this.deps.jobs.markObsolete(
        job.historyId,
        'source_expired',
        `History source object expired at ${ref.resultExpiresAt}`,
        nowIso,
      );
      return 'obsolete';
    }
    if (ref.parquetRef) {
      if (ref.parquetRef.objectKey === job.targetObjectKey) {
        await this.deps.jobs.markComplete(job.historyId, nowIso);
        return 'complete';
      }
      await cleanupUnlinkedResultObject(job.targetObjectKey, {
        store: this.deps.resultStore,
        deletions: this.deps.resultObjectDeletions,
        now: this.now,
        logWarn: this.logWarn,
      });
      await this.deps.jobs.markComplete(job.historyId, nowIso);
      return 'complete';
    }
    if (!ref.columns) {
      await this.deps.jobs.markDead(
        job.historyId,
        job.attempts,
        'missing_columns',
        'History row has no result column metadata',
        nowIso,
      );
      return 'dead';
    }
    if (!ref.format) {
      await this.deps.jobs.markDead(
        job.historyId,
        job.attempts,
        'missing_format',
        'History row has no supported JSONL format',
        nowIso,
      );
      return 'dead';
    }
    return 'convert';
  }

  private async recordFailure(
    job: ResultParquetConversionJob,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const details = classifyFailure(error);
    const message = details.message;
    if (this.stopping || signal.aborted) {
      // shutdown abort は attempts を消費せず、pending の job をそのまま残す。
      return;
    }
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    if (details.noAttemptConsumption) {
      const delay = Math.min(this.config.backoffMs, MAX_BACKOFF_MS);
      await this.deps.jobs.markRetry(
        job.historyId,
        job.attempts,
        new Date(nowMs + delay).toISOString(),
        details.code,
        message,
        nowIso,
      );
      return;
    }
    const attempts = job.attempts + 1;
    if (details.permanent || attempts >= this.config.maxAttempts) {
      await this.deps.jobs.markDead(job.historyId, attempts, details.code, message, nowIso);
      this.logWarn(`result parquet conversion moved to dead: history_id=${job.historyId}`, error);
      return;
    }
    const delay = Math.min(
      this.config.backoffMs * 2 ** Math.min(Math.max(attempts - 1, 0), 30),
      MAX_BACKOFF_MS,
    );
    await this.deps.jobs.markRetry(
      job.historyId,
      attempts,
      new Date(nowMs + delay).toISOString(),
      details.code,
      message,
      nowIso,
    );
  }
}

function classifyFailure(error: unknown): {
  code: string;
  message: string;
  permanent: boolean;
  noAttemptConsumption: boolean;
} {
  if (error instanceof ParquetConverterError) {
    return {
      code: error.code,
      message: error.message,
      permanent: error.permanent,
      noAttemptConsumption: error.code === 'aborted',
    };
  }
  return {
    code: 'worker_error',
    message: error instanceof Error ? error.message : String(error),
    permanent: false,
    noAttemptConsumption: false,
  };
}

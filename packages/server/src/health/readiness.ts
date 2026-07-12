/**
 * Kubernetes readiness 用に DB と既定エンジンの疎通状態を短い期限で確認する。
 * 同時リクエストは一つの probe を共有し、直近結果を短時間だけ再利用する。
 */
import type { SqlDatabase } from '../db/sqlDatabase';
import type { QueryEngine } from '../engine/types';

/** readiness の依存先ごとの確認結果。 */
export type ReadinessCheckState = 'ok' | 'failed' | 'timeout';

/** readiness endpoint が返す内部判定結果。 */
export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: ReadinessCheckState;
    defaultEngine: ReadinessCheckState;
  };
}

interface ReadinessServiceDeps {
  db: SqlDatabase;
  getDefaultEngine: () => QueryEngine | undefined;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_MS = 5_000;

type MutableCheckState = ReadinessCheckState | 'pending';

/** DB と既定エンジンの readiness probe を期限付きで実行する。 */
export class ReadinessService {
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cached?: { result: ReadinessResult; expiresAt: number };
  private inFlight?: Promise<ReadinessResult>;

  constructor(private readonly deps: ReadinessServiceDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;
    this.now = deps.now ?? Date.now;
  }

  /** 直近結果または共有中の probe を返し、必要な場合だけ新しい probe を始める。 */
  check(): Promise<ReadinessResult> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.result);
    }
    if (this.inFlight) return this.inFlight;

    const controller = new AbortController();
    let database: MutableCheckState = 'pending';
    let defaultEngine: MutableCheckState = 'pending';

    const databaseCheck = this.deps.db
      .query('SELECT 1 AS ready')
      .then(() => {
        database = 'ok';
      })
      .catch(() => {
        database = 'failed';
      });
    const engine = this.deps.getDefaultEngine();
    const engineCheck = (
      engine
        ? engine.probe(controller.signal)
        : Promise.reject(new Error('Default engine is not configured'))
    )
      .then(() => {
        defaultEngine = 'ok';
      })
      .catch(() => {
        defaultEngine = 'failed';
      });

    const completed = Promise.all([databaseCheck, engineCheck]).then(() =>
      resultFor(
        database === 'pending' ? 'failed' : database,
        defaultEngine === 'pending' ? 'failed' : defaultEngine,
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ReadinessResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(
          resultFor(
            database === 'pending' ? 'timeout' : database,
            defaultEngine === 'pending' ? 'timeout' : defaultEngine,
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();
    });

    const response = Promise.race([completed, timedOut]);
    this.inFlight = response;
    void response.then((result) => {
      // 古い probe の遅延完了から、新しい世代の cache と in-flight 状態を保護する。
      if (this.inFlight !== response) return;
      this.cached = { result, expiresAt: this.now() + this.cacheMs };
      if (timer) clearTimeout(timer);
      this.inFlight = undefined;
    });
    return response;
  }
}

/** 二つの依存状態から endpoint の判定結果を組み立てる。 */
function resultFor(
  database: ReadinessCheckState,
  defaultEngine: ReadinessCheckState,
): ReadinessResult {
  return {
    ready: database === 'ok' && defaultEngine === 'ok',
    checks: { database, defaultEngine },
  };
}

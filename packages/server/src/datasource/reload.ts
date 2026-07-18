/**
 * datasources.yaml ホットリロード時のエンジン差し替えロジック。
 */
import type { ResolvedDatasource } from './types';
import { createEngineForDatasource, type BuildEnginesOptions } from '../engine/factory';
import type { QueryEngine } from '../engine/types';

/** 旧エンジンの close 待ち上限（ミリ秒）。超過してもリロード自体はブロックしない。 */
export const ENGINE_CLOSE_TIMEOUT_MS = 60_000;

/** 公開前の候補エンジンを共通期限内で疎通確認する。 */
export async function probeCandidateEngines(
  plan: DatasourceReloadPlan,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let rejectDeadline: (reason: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error(`engine probe timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  const probes = [...plan.enginesToSet.values()].map((engine) => engine.probe(controller.signal));
  try {
    await Promise.race([Promise.all(probes), deadline]);
  } catch (err) {
    controller.abort();
    // 候補は公開しないため、期限を無視するドライバの終了待ちは reload を止めない。
    void Promise.allSettled(probes);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 2つの `ResolvedDatasource` が等価かを判定する。JSON 文字列比較のためキー順序に依存する。 */
export function resolvedDatasourceEqual(a: ResolvedDatasource, b: ResolvedDatasource): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface DatasourceReloadPlan {
  datasources: ResolvedDatasource[];
  defaultDatasourceId: string;
  enginesToSet: Map<string, QueryEngine>;
  idsToRemove: string[];
  enginesToClose: QueryEngine[];
  invalidateDatasourceIds: string[];
}

/**
 * 現行のエンジン集合と新しい datasources.yaml の内容を突き合わせ、どのエンジンを
 * 新規作成、維持、close するかの計画を作る（副作用は起こさない）。定義が変わらない
 * データソースは既存エンジンを使い続け、変わったものだけ新エンジンを候補として作る。
 */
export function planDatasourceReload(
  currentEngines: Map<string, QueryEngine>,
  currentDatasources: ResolvedDatasource[],
  nextDatasources: ResolvedDatasource[],
  buildOptions: BuildEnginesOptions,
): DatasourceReloadPlan {
  const first = nextDatasources[0];
  if (!first) throw new Error('At least one datasource must be configured');
  const defaultDatasourceId = first.id;
  const enginesToSet = new Map<string, QueryEngine>();
  const enginesToClose: QueryEngine[] = [];
  const invalidateDatasourceIds = new Set<string>();
  const nextIds = new Set(nextDatasources.map((ds) => ds.id));

  for (const ds of nextDatasources) {
    const existingEngine = currentEngines.get(ds.id);
    const prev = currentDatasources.find((d) => d.id === ds.id);
    if (existingEngine && prev && resolvedDatasourceEqual(prev, ds)) continue;
    if (existingEngine) {
      enginesToClose.push(existingEngine);
      invalidateDatasourceIds.add(ds.id);
    }
    enginesToSet.set(ds.id, createEngineForDatasource(ds, buildOptions));
  }

  for (const ds of currentDatasources) {
    if (!nextIds.has(ds.id)) {
      const engine = currentEngines.get(ds.id);
      if (engine) enginesToClose.push(engine);
      invalidateDatasourceIds.add(ds.id);
    }
  }

  return {
    datasources: nextDatasources,
    defaultDatasourceId,
    enginesToSet,
    idsToRemove: [...currentEngines.keys()].filter((id) => !nextIds.has(id)),
    enginesToClose,
    invalidateDatasourceIds: [...invalidateDatasourceIds],
  };
}

/** エンジンを close するが、`timeoutMs` を超えたら待たずに諦めてログ警告だけ出す。 */
export async function closeEngineWithTimeout(
  engine: QueryEngine,
  timeoutMs: number,
  logWarn: (message: string) => void = console.warn,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('engine close timed out')), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([engine.close(), timeout]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logWarn(`engine ${engine.datasourceId} close failed: ${detail}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `applyDatasourceReloadSync` が書き換える、サービス側が保持する可変状態。 */
export interface DatasourceReloadTarget {
  engines: Map<string, QueryEngine>;
  datasources: ResolvedDatasource[];
  setDefaultDatasourceId: (id: string) => void;
  invalidateDatasource: (id: string) => void;
}

/**
 * `probeCandidateEngines` で疎通確認済みの `plan` を、同期的かつ一括で `target` へ
 * 適用する。エンジン集合の入れ替えとデータソース一覧の差し替えの間に await を挟むと、
 * その間に実行中のクエリが古いエンジンと新しいデータソース一覧の不整合な組み合わせを
 * 参照し得るため、この関数は意図的に非同期処理を行わない。旧エンジンの close だけは
 * 即座に `void` で fire-and-forget し、リロード自体をブロックしない。
 */
export function applyDatasourceReloadSync(
  target: DatasourceReloadTarget,
  plan: DatasourceReloadPlan,
  logWarn: (message: string) => void = console.warn,
): void {
  for (const id of plan.idsToRemove) target.engines.delete(id);
  for (const [id, engine] of plan.enginesToSet) target.engines.set(id, engine);
  target.datasources.length = 0;
  target.datasources.push(...plan.datasources);
  target.setDefaultDatasourceId(plan.defaultDatasourceId);
  for (const id of plan.invalidateDatasourceIds) target.invalidateDatasource(id);
  for (const engine of plan.enginesToClose) {
    void closeEngineWithTimeout(engine, ENGINE_CLOSE_TIMEOUT_MS, logWarn);
  }
}

/** commit されなかった候補エンジンを閉じる。 */
export function closeCandidateEngines(
  plan: DatasourceReloadPlan,
  logWarn: (message: string) => void = console.warn,
): void {
  for (const engine of plan.enginesToSet.values()) {
    void closeEngineWithTimeout(engine, ENGINE_CLOSE_TIMEOUT_MS, logWarn);
  }
}

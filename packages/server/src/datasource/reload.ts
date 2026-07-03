/**
 * datasources.yaml ホットリロード時のエンジン差し替えロジック。
 */
import type { ResolvedDatasource } from './types';
import {
  buildEngines,
  createEngineForDatasource,
  type BuildEnginesOptions,
} from '../engine/factory';
import type { QueryEngine } from '../engine/types';

export const ENGINE_CLOSE_TIMEOUT_MS = 60_000;

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

export function planDatasourceReload(
  currentEngines: Map<string, QueryEngine>,
  currentDatasources: ResolvedDatasource[],
  nextDatasources: ResolvedDatasource[],
  buildOptions: BuildEnginesOptions,
): DatasourceReloadPlan {
  const { defaultDatasourceId } = buildEngines(nextDatasources, buildOptions);
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

export async function closeEngineWithTimeout(
  engine: QueryEngine,
  timeoutMs: number,
  logWarn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    await Promise.race([
      engine.close(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('engine close timed out')), timeoutMs);
      }),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logWarn(`engine ${engine.datasourceId} close failed: ${detail}`);
  }
}

export interface DatasourceReloadTarget {
  engines: Map<string, QueryEngine>;
  datasources: ResolvedDatasource[];
  setDefaultDatasourceId: (id: string) => void;
  invalidateDatasource: (id: string) => void;
}

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

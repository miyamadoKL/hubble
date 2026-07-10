/**
 * ResolvedDatasource 一覧から QueryEngine マップを構築する。
 */
import type { ServerConfig } from '../config';
import type { ResolvedDatasource } from '../datasource/types';
import { createMysqlEngine } from './mysql/engine';
import type { MysqlPoolFactory } from './mysql/pool';
import { createPostgresqlEngine } from './postgresql/engine';
import type { PgPoolFactory } from './postgresql/pool';
import { createTrinoEngine } from './trino';
import { LeasedEngine } from './leasedEngine';
import type { QueryEngine } from './types';

export interface BuildEnginesOptions {
  trinoConfig: ServerConfig['trino'];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  mysqlPoolFactory?: MysqlPoolFactory;
  pgPoolFactory?: PgPoolFactory;
}

export function buildEngines(
  datasources: ResolvedDatasource[],
  options: BuildEnginesOptions,
): { engines: Map<string, QueryEngine>; defaultDatasourceId: string } {
  const engines = new Map<string, QueryEngine>();
  for (const ds of datasources) {
    engines.set(ds.id, createEngineForDatasource(ds, options));
  }
  const first = datasources[0];
  if (!first) throw new Error('At least one datasource must be configured');
  return { engines, defaultDatasourceId: first.id };
}

export function createEngineForDatasource(
  ds: ResolvedDatasource,
  options: BuildEnginesOptions,
): QueryEngine {
  let engine: QueryEngine;
  switch (ds.type) {
    case 'trino':
      engine = createTrinoEngine({
        datasource: ds,
        trinoConfig: options.trinoConfig,
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
        now: options.now,
      });
      break;
    case 'mysql':
      engine = createMysqlEngine({ datasource: ds, poolFactory: options.mysqlPoolFactory });
      break;
    case 'postgresql':
      engine = createPostgresqlEngine({ datasource: ds, poolFactory: options.pgPoolFactory });
      break;
    default: {
      const _exhaustive: never = ds;
      throw new Error(`Unsupported datasource type: ${(_exhaustive as ResolvedDatasource).type}`);
    }
  }
  return new LeasedEngine(engine);
}

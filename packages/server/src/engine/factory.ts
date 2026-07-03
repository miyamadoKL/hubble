/**
 * ResolvedDatasource 一覧から QueryEngine マップを構築する。
 */
import type { ServerConfig } from '../config';
import type { ResolvedDatasource } from '../datasource/types';
import { createTrinoEngine } from './trino';
import { createUnsupportedEngine } from './unsupported';
import type { QueryEngine } from './types';

/** buildEngines に渡すオプション。 */
export interface BuildEnginesOptions {
  trinoConfig: ServerConfig['trino'];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * 解決済みデータソース一覧からエンジンマップを構築する（YAML の記述順を保つ）。
 * @param datasources - loadDatasources() の結果。
 * @param options - Trino 設定とテスト用注入。
 * @returns id をキーにした QueryEngine マップと既定 id（先頭）。
 */
export function buildEngines(
  datasources: ResolvedDatasource[],
  options: BuildEnginesOptions,
): { engines: Map<string, QueryEngine>; defaultDatasourceId: string } {
  const engines = new Map<string, QueryEngine>();

  for (const ds of datasources) {
    switch (ds.type) {
      case 'trino':
        engines.set(
          ds.id,
          createTrinoEngine({
            datasource: ds,
            trinoConfig: options.trinoConfig,
            fetchImpl: options.fetchImpl,
            sleepImpl: options.sleepImpl,
            now: options.now,
          }),
        );
        break;
      case 'mysql':
      case 'postgresql':
        engines.set(ds.id, createUnsupportedEngine(ds.id, ds.type));
        break;
    }
  }

  const first = datasources[0];
  if (!first) {
    throw new Error('At least one datasource must be configured');
  }

  return { engines, defaultDatasourceId: first.id };
}
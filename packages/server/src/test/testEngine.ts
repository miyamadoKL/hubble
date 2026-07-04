/**
 * QueryEngine 系テスト用のヘルパー。
 */
import type { ServerConfig } from '../config';
import type { ResolvedTrinoDatasource } from '../datasource/types';
import { createTrinoEngine } from '../engine/trino';
import type { QueryEngine } from '../engine/types';
import type { FakeTrino } from './fakeTrino';

/** テストで使う既定の Trino 横断設定(datasources.yaml 必須化後は impersonation ユーザーのみ)。 */
export const TEST_TRINO_CONFIG: ServerConfig['trino'] = {
  user: 'admin',
};

/** テスト用の既定データソース id(datasources.yaml が無い場合の後方互換名を踏襲)。 */
export const DEFAULT_DATASOURCE_ID = 'trino-default';

/**
 * 解決済み Trino データソースのテスト用インスタンスを組み立てる。
 * @param overrides - 上書きするフィールド。
 * @returns FakeTrino に接続可能なデータソース定義。
 */
export function makeTrinoDatasource(
  overrides: Partial<ResolvedTrinoDatasource> = {},
): ResolvedTrinoDatasource {
  return {
    id: DEFAULT_DATASOURCE_ID,
    type: 'trino',
    displayName: 'Trino',
    username: 'admin',
    password: '',
    baseUrl: 'http://trino.test',
    source: 'hubble',
    metadataSource: 'hubble-metadata',
    scheduledSource: 'hubble-scheduled',
    ...overrides,
  };
}

/**
 * FakeTrino へ接続する TrinoEngine を 1 件構築する。
 * @param fake - 注入する FakeTrino。
 * @param overrides - データソース定義の上書き。
 * @returns QueryEngine 実装。
 */
export function makeTrinoEngine(
  fake: FakeTrino,
  overrides: Partial<ResolvedTrinoDatasource> = {},
): QueryEngine {
  return createTrinoEngine({
    datasource: makeTrinoDatasource(overrides),
    trinoConfig: TEST_TRINO_CONFIG,
    fetchImpl: fake.fetch,
    sleepImpl: () => Promise.resolve(),
  });
}

/**
 * 複数 Trino データソース向けのエンジンマップを構築する。
 * @param fake - 共有 FakeTrino（X-Trino-Source で振り分けを検証する）。
 * @param datasources - データソース定義の上書き配列（先頭が default）。
 * @returns engines マップと defaultDatasourceId。
 */
export function makeEnginesMap(
  fake: FakeTrino,
  datasources: Partial<ResolvedTrinoDatasource>[] = [{}],
): { engines: Map<string, QueryEngine>; defaultDatasourceId: string } {
  const engines = new Map<string, QueryEngine>();
  for (const overrides of datasources) {
    const ds = makeTrinoDatasource(overrides);
    engines.set(ds.id, makeTrinoEngine(fake, overrides));
  }
  const defaultDatasourceId = makeTrinoDatasource(datasources[0] ?? {}).id;
  return { engines, defaultDatasourceId };
}

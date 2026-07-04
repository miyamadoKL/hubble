import { describe, expect, test } from 'vitest';
import { DATASOURCES_STALE_MS, resolveDatasourceLabel } from './useDatasources';
import type { DatasourceSummary } from '@hubble/contracts';

const datasources: DatasourceSummary[] = [
  {
    id: 'trino-default',
    kind: 'trino',
    displayName: 'Trino cluster',
    capabilities: { costEstimate: true, catalogs: true },
  },
  {
    id: 'mysql-1',
    kind: 'mysql',
    displayName: 'MySQL dev',
    capabilities: { costEstimate: false, catalogs: false },
  },
];

describe('resolveDatasourceLabel', () => {
  test('resolves displayName when id exists', () => {
    expect(resolveDatasourceLabel(datasources, 'mysql-1')).toBe('MySQL dev');
  });

  test('falls back to raw id when missing', () => {
    expect(resolveDatasourceLabel(datasources, 'gone')).toBe('gone');
  });

  test('returns dash for empty id', () => {
    expect(resolveDatasourceLabel(datasources, null)).toBe('—');
  });
});

describe('DATASOURCES_STALE_MS', () => {
  // rbac.yaml / datasources.yaml のホットリロードで allowlist が実行時に変わる
  // ため、staleTime を Infinity に戻すと既存タブがページ再読み込みまで古い
  // 一覧を表示し続ける回帰が起きる。有限値であることをここで固定する。
  test('is finite so the list eventually refetches without a page reload', () => {
    expect(DATASOURCES_STALE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DATASOURCES_STALE_MS)).toBe(true);
  });
});

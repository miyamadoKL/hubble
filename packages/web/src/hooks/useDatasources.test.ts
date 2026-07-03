import { describe, expect, test } from 'vitest';
import { resolveDatasourceLabel } from './useDatasources';
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

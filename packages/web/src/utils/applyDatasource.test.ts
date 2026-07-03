import { beforeEach, describe, expect, test } from 'vitest';
import type { DatasourceSummary } from '@hubble/contracts';
import { useDatasourceStore } from '../stores/datasourceStore';
import { trySelectDatasource } from './applyDatasource';

const datasources: DatasourceSummary[] = [
  {
    id: 'a',
    kind: 'trino',
    displayName: 'A',
    capabilities: { costEstimate: true, catalogs: true },
  },
  {
    id: 'b',
    kind: 'mysql',
    displayName: 'B',
    capabilities: { costEstimate: false, catalogs: false },
  },
];

describe('trySelectDatasource', () => {
  beforeEach(() => {
    useDatasourceStore.setState({ selectedId: 'a' });
  });

  test('switches when id exists in list', () => {
    expect(trySelectDatasource(datasources, 'b')).toBe(true);
    expect(useDatasourceStore.getState().selectedId).toBe('b');
  });

  test('returns false when id is missing', () => {
    expect(trySelectDatasource(datasources, 'missing')).toBe(false);
    expect(useDatasourceStore.getState().selectedId).toBe('a');
  });

  test('no-op when datasourceId is omitted', () => {
    expect(trySelectDatasource(datasources, undefined)).toBe(true);
    expect(useDatasourceStore.getState().selectedId).toBe('a');
  });
});

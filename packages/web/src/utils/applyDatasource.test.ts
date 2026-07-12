import { beforeEach, describe, expect, test } from 'vitest';
import type { DatasourceSummary } from '@hubble/contracts';
import { useDatasourceStore } from '../stores/datasourceStore';
import { useUiStore } from '../stores/uiStore';
import { recordRecentContext } from '../notebook/recentContexts';
import { tryApplyExecutionContext, trySelectDatasource } from './applyDatasource';

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
    localStorage.clear();
    useDatasourceStore.setState({
      selectedId: 'a',
      executionContext: { datasourceId: 'a', catalog: 'catalog-a', schema: 'schema-a' },
    });
    useUiStore.setState({
      shellContext: { datasourceId: 'a', catalog: 'catalog-a', schema: 'schema-a' },
      shellDefaultLimit: 5000,
    });
  });

  test('switches when id exists in list', () => {
    expect(trySelectDatasource(datasources, 'b')).toBe(true);
    expect(useDatasourceStore.getState().selectedId).toBe('b');
    expect(useDatasourceStore.getState().executionContext).toEqual({
      datasourceId: 'b',
      catalog: '',
      schema: '',
    });
  });

  test('returns false when id is missing', () => {
    expect(trySelectDatasource(datasources, 'missing')).toBe(false);
    expect(useDatasourceStore.getState().selectedId).toBe('a');
    expect(useDatasourceStore.getState().executionContext.datasourceId).toBe('a');
  });

  test('no-op when datasourceId is omitted', () => {
    expect(trySelectDatasource(datasources, undefined)).toBe(true);
    expect(useDatasourceStore.getState().selectedId).toBe('a');
  });

  test('applies a saved query execution context as one tuple', () => {
    expect(
      tryApplyExecutionContext(datasources, {
        datasourceId: 'b',
        catalog: 'warehouse',
        schema: 'production',
      }),
    ).toBe(true);

    const expected = {
      datasourceId: 'b',
      catalog: 'warehouse',
      schema: 'production',
    };
    expect(useDatasourceStore.getState().executionContext).toEqual(expected);
    expect(useUiStore.getState().shellContext).toEqual(expected);
  });

  test('restores a datasource-specific recent context instead of retaining the previous one', () => {
    recordRecentContext({ datasourceId: 'b', catalog: 'warehouse', schema: 'analytics' });

    expect(trySelectDatasource(datasources, 'b')).toBe(true);
    expect(useDatasourceStore.getState().executionContext).toEqual({
      datasourceId: 'b',
      catalog: 'warehouse',
      schema: 'analytics',
    });
  });
});

import { beforeEach, describe, expect, test } from 'vitest';
import { recordRecentContext } from '../notebook/recentContexts';
import { useDatasourceStore } from './datasourceStore';

describe('datasourceStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useDatasourceStore.setState({
      selectedId: null,
      executionContext: { catalog: '', schema: '' },
    });
  });

  test('persists selected datasource id', () => {
    useDatasourceStore.getState().setSelectedId('mysql-1');
    expect(useDatasourceStore.getState().selectedId).toBe('mysql-1');
    expect(useDatasourceStore.getState().executionContext).toEqual({
      datasourceId: 'mysql-1',
      catalog: '',
      schema: '',
    });
  });

  test('switches datasource together with its own most-recent context', () => {
    recordRecentContext({ datasourceId: 'trino-a', catalog: 'sales', schema: 'public' });
    recordRecentContext({ datasourceId: 'trino-b', catalog: 'warehouse', schema: 'analytics' });

    useDatasourceStore.getState().setSelectedId('trino-a');
    expect(useDatasourceStore.getState().executionContext).toEqual({
      datasourceId: 'trino-a',
      catalog: 'sales',
      schema: 'public',
    });
    useDatasourceStore.getState().setSelectedId('trino-b');
    expect(useDatasourceStore.getState().executionContext).toEqual({
      datasourceId: 'trino-b',
      catalog: 'warehouse',
      schema: 'analytics',
    });
  });
});

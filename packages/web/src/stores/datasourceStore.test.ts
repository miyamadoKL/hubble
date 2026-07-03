import { beforeEach, describe, expect, test } from 'vitest';
import { useDatasourceStore } from './datasourceStore';

describe('datasourceStore', () => {
  beforeEach(() => {
    useDatasourceStore.setState({ selectedId: null });
  });

  test('persists selected datasource id', () => {
    useDatasourceStore.getState().setSelectedId('mysql-1');
    expect(useDatasourceStore.getState().selectedId).toBe('mysql-1');
  });
});
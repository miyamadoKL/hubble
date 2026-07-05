import { describe, expect, it } from 'vitest';
import type { Notebook, SavedQuery } from '@hubble/contracts';
import type { WorkflowRecord } from '../store/workflows';
import {
  branchNameFor,
  contentHash,
  documentPath,
  notebookToContent,
  savedQueryToContent,
  workflowToContent,
} from './canonical';

const savedQuery: SavedQuery = {
  id: 'sq_1',
  name: 'Revenue',
  description: 'Monthly revenue',
  statement: 'SELECT 1',
  catalog: 'hive',
  schema: 'default',
  datasourceId: 'trino-default',
  isFavorite: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  owner: 'alice',
  myPermission: 'owner',
};

const notebook: Notebook = {
  id: 'nb_1',
  name: 'Analysis',
  description: 'Notebook desc',
  context: { catalog: 'hive', schema: 'default' },
  variables: [{ name: 'day', value: '2026-01-01', meta: { type: 'date' } }],
  cells: [
    {
      id: 'c1',
      kind: 'sql',
      source: 'SELECT 1',
      name: 'First',
      collapsed: true,
      resultMeta: { rowCount: 1, executedAt: '2026-01-01T00:00:00.000Z' },
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  owner: 'alice',
  myPermission: 'owner',
};

const workflow: WorkflowRecord = {
  id: 'wfl_1',
  owner: 'alice',
  name: 'Daily',
  description: 'Daily flow',
  stages: [{ steps: [{ id: 'st1', name: 'Step', statement: 'SELECT 1', onFailure: 'stop' }] }],
  datasourceId: 'trino-default',
  cron: '0 9 * * *',
  enabled: false,
  retry: { maxAttempts: 1, backoffSeconds: 1, backoffMultiplier: 2 },
  principalSnapshot: { user: 'alice' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

describe('github canonical', () => {
  it('serializes saved query header and statement', () => {
    expect(savedQueryToContent(savedQuery)).toBe(
      [
        '-- name: Revenue',
        '-- description: Monthly revenue',
        '-- datasource: trino-default',
        '-- catalog: hive',
        '-- schema: default',
        '',
        'SELECT 1',
        '',
      ].join('\n'),
    );
  });

  it('omits volatile saved query fields from canonical content', () => {
    const changed = {
      ...savedQuery,
      isFavorite: false,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-02T00:00:00.000Z',
      owner: 'bob',
      myPermission: 'view' as const,
    };
    expect(savedQueryToContent(changed)).toBe(savedQueryToContent(savedQuery));
  });

  it('changes hash when statement changes', () => {
    const base = savedQueryToContent(savedQuery);
    const changed = savedQueryToContent({ ...savedQuery, statement: 'SELECT 2' });
    expect(contentHash(base)).not.toBe(contentHash(changed));
  });

  it('serializes notebook yaml without volatile fields', () => {
    const content = notebookToContent(notebook);
    expect(content).toContain('id: nb_1');
    expect(content).toContain('kind: sql');
    expect(content).not.toContain('resultMeta');
    expect(content).not.toContain('createdAt');
    expect(content).not.toContain('owner');
  });

  it('serializes workflow yaml without volatile fields', () => {
    const content = workflowToContent(workflow);
    expect(content).toContain('id: wfl_1');
    expect(content).toContain('onFailure: stop');
    expect(content).not.toContain('enabled');
    expect(content).not.toContain('principalSnapshot');
    expect(content).not.toContain('createdAt');
  });

  it('builds stable document paths and branch names', () => {
    expect(documentPath('saved_query', 'sq_1')).toBe('saved-queries/sq_1.sql');
    expect(documentPath('notebook', 'nb_1')).toBe('notebooks/nb_1.yaml');
    expect(documentPath('workflow', 'wfl_1')).toBe('workflows/wfl_1.yaml');
    expect(branchNameFor('alice@corp', 'saved_query', 'sq_1')).toBe(
      'hubble/alice-corp/saved_query-sq_1',
    );
  });
});

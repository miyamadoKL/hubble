import { describe, expect, it } from 'vitest';
import type { Notebook, SavedQuery, Dashboard } from '@hubble/contracts';
import type { WorkflowRecord } from '../store/workflows';
import type { AlertRecord } from '../store/alerts';
import {
  alertToContent,
  branchNameFor,
  contentHash,
  dashboardToContent,
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
  revision: 1,
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
      chart: {
        type: 'lines',
        xIndex: 0,
        yIndices: [1, 2],
        sort: 'none',
        limit: 'all',
        groupIndex: null,
        sizeIndex: null,
      },
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

const alert: AlertRecord = {
  id: 'alt_1',
  owner: 'alice',
  name: 'Spike',
  savedQueryId: 'sq_1',
  columnName: 'count',
  op: '>',
  value: '100',
  selector: 'first',
  rearm: 0,
  muted: false,
  cron: '0 * * * *',
  state: 'triggered',
  lastTriggeredAt: '2026-01-01T00:00:00.000Z',
  notifications: {
    channels: ['webhook', 'email'],
    emailTo: ['ops@example.com'],
    webhookUrl: 'https://secret.example/hook',
  },
  principalSnapshot: { user: 'alice' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const dashboard: Dashboard = {
  id: 'dsh_1',
  name: 'Ops board',
  description: 'Daily metrics',
  widgets: [
    {
      id: 'w1',
      kind: 'query',
      position: { col: 0, row: 0, sizeX: 6, sizeY: 4 },
      savedQueryId: 'sq_1',
      viz: 'chart',
      chart: {
        type: 'bars',
        xIndex: 0,
        yIndices: [1],
        sort: 'none',
        limit: 10,
      },
      title: 'Revenue',
    },
    {
      id: 'w2',
      kind: 'text',
      position: { col: 6, row: 0, sizeX: 6, sizeY: 2 },
      text: '# Notes',
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  owner: 'alice',
  myPermission: 'owner',
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
    // チャート設定はユーザーコンテンツなので正規形に含まれる。
    expect(content).toContain('chart:');
    expect(content).toContain('type: lines');
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

  it('serializes alert yaml without volatile fields', () => {
    const content = alertToContent(alert);
    expect(content).toContain('savedQueryId: sq_1');
    expect(content).toContain('op: ">"');
    expect(content).toContain('webhook');
    expect(content).toContain('ops@example.com');
    expect(content).not.toContain('webhookUrl');
    expect(content).not.toContain('https://secret.example/hook');
    expect(content).not.toContain('state');
    expect(content).not.toContain('lastTriggeredAt');
    expect(content).not.toContain('owner');
  });

  it('serializes dashboard yaml without volatile fields', () => {
    const content = dashboardToContent(dashboard);
    expect(content).toContain('id: dsh_1');
    expect(content).toContain('savedQueryId: sq_1');
    expect(content).toContain('kind: text');
    expect(content).not.toContain('createdAt');
    expect(content).not.toContain('updatedAt');
    expect(content).not.toContain('owner');
    expect(content).not.toContain('myPermission');
  });

  it('builds stable document paths and branch names', () => {
    expect(documentPath('saved_query', 'sq_1')).toBe('saved-queries/sq_1.sql');
    expect(documentPath('notebook', 'nb_1')).toBe('notebooks/nb_1.yaml');
    expect(documentPath('workflow', 'wfl_1')).toBe('workflows/wfl_1.yaml');
    expect(documentPath('alert', 'alt_1')).toBe('alerts/alt_1.yaml');
    expect(documentPath('dashboard', 'dsh_1')).toBe('dashboards/dsh_1.yaml');
    expect(branchNameFor('alice@corp', 'saved_query', 'sq_1')).toBe(
      'hubble/alice-corp/saved_query-sq_1',
    );
  });
});

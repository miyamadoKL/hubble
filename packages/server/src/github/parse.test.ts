import { describe, expect, it } from 'vitest';
import type { Notebook } from '@hubble/contracts';
import type { WorkflowRecord } from '../store/workflows';
import {
  notebookToContent,
  savedQueryToContent,
  workflowToContent,
  alertToContent,
  dashboardToContent,
} from './canonical';
import {
  parseAlertContent,
  parseDashboardContent,
  parseNotebookContent,
  parseSavedQueryContent,
  parseWorkflowContent,
} from './parse';
import type { AlertRecord } from '../store/alerts';
import type { Dashboard } from '@hubble/contracts';

describe('parseSavedQueryContent', () => {
  it('round-trips saved query canonical content', () => {
    const original = {
      id: 'sq_abc',
      name: 'My Query',
      description: 'desc',
      statement: 'SELECT 1',
      catalog: 'hive',
      schema: 'default',
      datasourceId: 'trino-default',
      isFavorite: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const content = savedQueryToContent(original);
    const parsed = parseSavedQueryContent(content);
    expect(parsed).toEqual({
      name: original.name,
      description: original.description,
      statement: original.statement,
      catalog: original.catalog,
      schema: original.schema,
      datasourceId: original.datasourceId,
    });
  });

  it('starts body at first non-header line', () => {
    const content = `-- name: Q\nSELECT 1\n`;
    expect(parseSavedQueryContent(content).statement).toBe('SELECT 1');
  });

  it('throws when name header is missing', () => {
    expect(() => parseSavedQueryContent('SELECT 1')).toThrow(/Missing required header/);
  });

  it('throws when statement is empty', () => {
    expect(() => parseSavedQueryContent('-- name: Q\n\n')).toThrow(/empty/);
  });
});

describe('parseNotebookContent', () => {
  it('round-trips notebook canonical content with new cell ids', () => {
    const original: Notebook = {
      id: 'nb_abc',
      name: 'NB',
      description: 'desc',
      context: { catalog: 'hive', schema: 'default' },
      variables: [
        {
          name: 'limit',
          value: '10',
          meta: { type: 'number' },
        },
      ],
      cells: [
        { id: 'c_old', kind: 'markdown', source: '# Title', collapsed: true },
        {
          id: 'c_old2',
          kind: 'sql',
          source: 'SELECT 1',
          name: 'q1',
          // チャート設定も正規形に含まれ、pull で復元されることを確認する。
          chart: {
            type: 'bars',
            xIndex: 0,
            yIndices: [1],
            sort: 'desc',
            limit: 25,
            groupIndex: null,
            sizeIndex: null,
          },
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const content = notebookToContent(original);
    const parsed = parseNotebookContent(content);
    expect(parsed.name).toBe(original.name);
    expect(parsed.description).toBe(original.description);
    expect(parsed.context).toEqual(original.context);
    expect(parsed.variables).toEqual(original.variables);
    expect(parsed.cells).toHaveLength(2);
    expect(parsed.cells.every((cell) => cell.id.startsWith('c_'))).toBe(true);
    expect(parsed.cells[0]?.kind).toBe('markdown');
    expect(parsed.cells[0]?.source).toBe('# Title');
    expect(parsed.cells[0]?.collapsed).toBe(true);
    expect(parsed.cells[1]?.name).toBe('q1');
    expect(parsed.cells[0]?.chart).toBeUndefined();
    expect(parsed.cells[1]?.chart).toEqual({
      type: 'bars',
      xIndex: 0,
      yIndices: [1],
      sort: 'desc',
      limit: 25,
      groupIndex: null,
      sizeIndex: null,
    });
  });

  it('throws on invalid YAML', () => {
    expect(() => parseNotebookContent('[{')).toThrow(/Invalid notebook YAML/);
  });

  it('throws on schema violation', () => {
    expect(() => parseNotebookContent('name: NB\ncells: []\n')).toThrow(/Invalid notebook content/);
  });
});

describe('parseWorkflowContent', () => {
  it('round-trips workflow canonical content', () => {
    const original: WorkflowRecord = {
      id: 'wfl_abc',
      owner: 'alice',
      name: 'WF',
      description: 'desc',
      datasourceId: 'trino-default',
      cron: '0 * * * *',
      enabled: false,
      retry: { maxAttempts: 2, backoffSeconds: 5, backoffMultiplier: 2 },
      stages: [
        {
          steps: [
            {
              id: 'step1',
              name: 'Step',
              statement: 'SELECT 1',
              onFailure: 'stop',
            },
          ],
        },
      ],
      principalSnapshot: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const content = workflowToContent(original);
    const parsed = parseWorkflowContent(content);
    expect(parsed.name).toBe(original.name);
    expect(parsed.description).toBe(original.description);
    expect(parsed.datasourceId).toBe(original.datasourceId);
    expect(parsed.cron).toBe(original.cron);
    expect(parsed.retry).toEqual(original.retry);
    expect(parsed.stages).toEqual(original.stages);
  });

  it('throws on invalid YAML', () => {
    expect(() => parseWorkflowContent('[{')).toThrow(/Invalid workflow YAML/);
  });

  it('throws when stages violate workflowDefinitionSchema', () => {
    const content = `name: WF
description: ""
datasourceId: trino-default
cron: null
retry:
  maxAttempts: 1
  backoffSeconds: 1
  backoffMultiplier: 1
stages: []
`;
    expect(() => parseWorkflowContent(content)).toThrow(/Invalid workflow content/);
  });
});

describe('parseAlertContent', () => {
  it('round-trips alert canonical content', () => {
    const original: AlertRecord = {
      id: 'alt_1',
      owner: 'alice',
      name: 'Spike',
      savedQueryId: 'sq_1',
      columnName: 'count',
      op: '>',
      value: '100',
      selector: 'max',
      rearm: 60,
      muted: false,
      cron: '0 * * * *',
      state: 'unknown',
      lastTriggeredAt: null,
      notifications: {
        channels: ['webhook', 'email'],
        emailTo: ['ops@example.com'],
        webhookUrl: 'https://example.com/hook',
      },
      principalSnapshot: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const parsed = parseAlertContent(alertToContent(original));
    expect(parsed.name).toBe(original.name);
    expect(parsed.savedQueryId).toBe(original.savedQueryId);
    expect(parsed.columnName).toBe(original.columnName);
    expect(parsed.op).toBe(original.op);
    expect(parsed.value).toBe(original.value);
    expect(parsed.selector).toBe(original.selector);
    expect(parsed.rearm).toBe(original.rearm);
    expect(parsed.notifications).toEqual({
      channels: ['webhook', 'email'],
      emailTo: ['ops@example.com'],
    });
  });
});

describe('parseDashboardContent', () => {
  it('round-trips dashboard canonical content and assigns new widget ids', () => {
    const original: Dashboard = {
      id: 'dsh_1',
      name: 'Board',
      description: 'desc',
      widgets: [
        {
          id: 'w_old',
          kind: 'query',
          position: { col: 0, row: 0, sizeX: 4, sizeY: 3 },
          savedQueryId: 'sq_1',
          viz: 'counter',
          counter: { columnIndex: 0, label: 'Total' },
        },
        {
          id: 'w_text',
          kind: 'text',
          position: { col: 4, row: 0, sizeX: 4, sizeY: 2 },
          text: 'Hello',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const parsed = parseDashboardContent(dashboardToContent(original));
    expect(parsed.name).toBe(original.name);
    expect(parsed.description).toBe(original.description);
    expect(parsed.widgets).toHaveLength(2);
    const queryWidget = parsed.widgets[0];
    expect(queryWidget?.kind).toBe('query');
    if (queryWidget?.kind === 'query') {
      expect(queryWidget.savedQueryId).toBe('sq_1');
      expect(queryWidget.id).not.toBe('w_old');
      expect(queryWidget.id.startsWith('wgt_')).toBe(true);
    }
    const textWidget = parsed.widgets[1];
    expect(textWidget?.kind).toBe('text');
    if (textWidget?.kind === 'text') {
      expect(textWidget.text).toBe('Hello');
    }
  });

  it('rejects invalid dashboard yaml', () => {
    expect(() => parseDashboardContent('name: X\nwidgets: not-a-list\n')).toThrow(
      /Invalid dashboard content/,
    );
  });
});

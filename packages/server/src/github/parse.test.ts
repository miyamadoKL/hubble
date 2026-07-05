import { describe, expect, it } from 'vitest';
import type { Notebook } from '@hubble/contracts';
import type { WorkflowRecord } from '../store/workflows';
import { notebookToContent, savedQueryToContent, workflowToContent } from './canonical';
import { parseNotebookContent, parseSavedQueryContent, parseWorkflowContent } from './parse';

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
        { id: 'c_old2', kind: 'sql', source: 'SELECT 1', name: 'q1' },
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

import { describe, it, expect } from 'vitest';
import {
  apiErrorSchema,
  appConfigSchema,
  meResponseSchema,
  permissionSchema,
  authModeSchema,
  catalogsResponseSchema,
  metadataResponseSchema,
  catalogSchema,
  sampleRowsResponseSchema,
  metadataRefreshRequestSchema,
  createQueryRequestSchema,
  queryStateSchema,
  queryStatsSchema,
  querySnapshotSchema,
  queryRowsPageSchema,
  createQueryResponseSchema,
  queryExportRequestSchema,
  queryExportResponseSchema,
  resultSearchRequestSchema,
  resultSearchPageSchema,
  resultProfileSchema,
  estimateRequestSchema,
  estimateResultSchema,
  guardConfigSchema,
  queryEventSchema,
  variableSchema,
  cellSchema,
  notebookSchema,
  createNotebookRequestSchema,
  updateNotebookRequestSchema,
  savedQuerySchema,
  createSavedQueryRequestSchema,
  queryHistoryEntrySchema,
  historyResponseSchema,
  scheduleSchema,
  createScheduleRequestSchema,
  updateScheduleRequestSchema,
  retryPolicySchema,
  scheduleNotificationsSchema,
  cronExpression,
  aiAssistRequestSchema,
  apiRoutes,
} from './index';

const ISO = '2026-06-12T10:00:00.000Z';

describe('error envelope', () => {
  it('parses a valid ApiError', () => {
    const value = {
      error: {
        code: 'TRINO_ERROR',
        message: 'syntax error',
        trinoErrorName: 'SYNTAX_ERROR',
        line: 1,
        column: 8,
      },
    };
    expect(apiErrorSchema.parse(value)).toEqual(value);
  });

  it('parses a minimal ApiError', () => {
    const value = { error: { code: 'NOT_FOUND', message: 'missing' } };
    expect(apiErrorSchema.safeParse(value).success).toBe(true);
  });

  it('rejects missing code', () => {
    expect(apiErrorSchema.safeParse({ error: { message: 'x' } }).success).toBe(false);
  });

  it('rejects non-positive line', () => {
    expect(apiErrorSchema.safeParse({ error: { code: 'C', message: 'm', line: 0 } }).success).toBe(
      false,
    );
  });
});

describe('config', () => {
  const valid = {
    trino: { url: 'http://127.0.0.1:30080', user: 'admin' },
    defaults: { catalog: 'tpch', schema: 'tiny', limit: 5000 },
    authMode: 'none',
    guard: {
      mode: 'warn',
      maxScanBytes: 0,
      maxScanRows: 0,
      onUnknown: 'warn',
      bytesPerSecond: 0,
    },
    // AI アシスタント無効時の公開設定（provider 未設定の既定値）。
    ai: { enabled: false, provider: 'off' },
    version: '0.1.0',
  };

  it('parses a valid AppConfig', () => {
    expect(appConfigSchema.parse(valid)).toEqual(valid);
  });

  it('parses AppConfig without optional defaults', () => {
    const v = { ...valid, defaults: { limit: 1000 } };
    expect(appConfigSchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown authMode', () => {
    const v = { ...valid, authMode: 'oauth' };
    expect(appConfigSchema.safeParse(v).success).toBe(false);
  });

  it('rejects a non-URL trino url', () => {
    const v = { ...valid, trino: { url: 'not a url', user: 'admin' } };
    expect(appConfigSchema.safeParse(v).success).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    const v = { ...valid, defaults: { limit: 0 } };
    expect(appConfigSchema.safeParse(v).success).toBe(false);
  });
});

describe('rbac', () => {
  it('accepts known permissions', () => {
    expect(permissionSchema.parse('query.write')).toBe('query.write');
    expect(permissionSchema.safeParse('query.admin').success).toBe(false);
  });
});

describe('auth', () => {
  it('accepts the two auth modes', () => {
    expect(authModeSchema.parse('none')).toBe('none');
    expect(authModeSchema.parse('proxy')).toBe('proxy');
    expect(authModeSchema.safeParse('basic').success).toBe(false);
  });

  it('parses a MeResponse with and without email', () => {
    expect(
      meResponseSchema.parse({
        user: 'alice',
        authMode: 'proxy',
        storageScope: 'a'.repeat(64),
        role: 'member',
        permissions: [],
        datasources: [],
      }),
    ).toEqual({
      user: 'alice',
      authMode: 'proxy',
      storageScope: 'a'.repeat(64),
      role: 'member',
      permissions: [],
      datasources: [],
    });
    expect(
      meResponseSchema.parse({
        user: 'alice',
        email: 'alice@example.com',
        authMode: 'proxy',
        storageScope: 'a'.repeat(64),
        role: 'admin',
        permissions: ['query.write'],
        datasources: [
          {
            id: 'trino-prod',
            kind: 'trino',
            displayName: 'Trino prod',
            capabilities: { costEstimate: true, catalogs: true },
          },
        ],
      }).email,
    ).toBe('alice@example.com');
  });

  it('rejects an empty user', () => {
    expect(meResponseSchema.safeParse({ user: '', authMode: 'none' }).success).toBe(false);
  });
});

describe('AI assistant input limits', () => {
  it('rejects table and context identifiers longer than 256 characters', () => {
    const long = 'x'.repeat(257);
    const validTable = {
      catalog: 'catalog',
      schema: 'schema',
      table: 'table',
      columns: [{ name: 'column', type: 'varchar' }],
    };
    const cases = [
      { ...validTable, catalog: long },
      { ...validTable, schema: long },
      { ...validTable, table: long },
      { ...validTable, columns: [{ name: long, type: 'varchar' }] },
      { ...validTable, columns: [{ name: 'column', type: long }] },
    ];

    for (const table of cases) {
      expect(
        aiAssistRequestSchema.safeParse({ task: 'draft', instruction: 'query', tables: [table] })
          .success,
      ).toBe(false);
    }
    expect(
      aiAssistRequestSchema.safeParse({
        task: 'draft',
        instruction: 'query',
        context: { catalog: long },
      }).success,
    ).toBe(false);
    expect(
      aiAssistRequestSchema.safeParse({
        task: 'draft',
        instruction: 'query',
        context: { schema: long },
      }).success,
    ).toBe(false);
  });
});

describe('metadata', () => {
  it('parses a MetadataResponse<Catalog>', () => {
    const value = {
      items: [{ name: 'tpch' }, { name: 'system' }],
      source: 'live',
      stale: false,
      lastUpdatedAt: ISO,
    };
    expect(catalogsResponseSchema.parse(value)).toEqual(value);
  });

  it('factory enforces the item schema', () => {
    const schema = metadataResponseSchema(catalogSchema);
    expect(
      schema.safeParse({ items: [{ nope: 1 }], source: 'cache', stale: true, lastUpdatedAt: ISO })
        .success,
    ).toBe(false);
  });

  it('rejects an invalid source', () => {
    expect(
      catalogsResponseSchema.safeParse({
        items: [],
        source: 'remote',
        stale: false,
        lastUpdatedAt: ISO,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO lastUpdatedAt', () => {
    expect(
      catalogsResponseSchema.safeParse({
        items: [],
        source: 'live',
        stale: false,
        lastUpdatedAt: 'yesterday',
      }).success,
    ).toBe(false);
  });

  it('parses a sample-rows response', () => {
    const value = {
      columns: [{ name: 'id', type: 'bigint' }],
      rows: [[1], [2]],
      source: 'live',
    };
    expect(sampleRowsResponseSchema.parse(value)).toEqual(value);
  });

  it('parses an empty metadata refresh request', () => {
    expect(metadataRefreshRequestSchema.parse({})).toEqual({});
  });
});

describe('query', () => {
  it('parses a full CreateQueryRequest', () => {
    const value = {
      statement: 'SELECT 1',
      catalog: 'tpch',
      schema: 'tiny',
      sessionProperties: { query_max_run_time: '5m' },
      source: 'hubble',
      notebookId: 'nb1',
      cellId: 'c1',
      maxRows: 100000,
    };
    expect(createQueryRequestSchema.parse(value)).toEqual(value);
  });

  it('rejects an empty statement', () => {
    expect(createQueryRequestSchema.safeParse({ statement: '' }).success).toBe(false);
  });

  it('accepts all query states', () => {
    for (const s of ['queued', 'running', 'finished', 'failed', 'canceled']) {
      expect(queryStateSchema.safeParse(s).success).toBe(true);
    }
    expect(queryStateSchema.safeParse('paused').success).toBe(false);
  });

  it('parses QueryStats', () => {
    const value = {
      progressPercentage: 42.5,
      state: 'RUNNING',
      queuedSplits: 0,
      runningSplits: 4,
      completedSplits: 10,
      totalSplits: 20,
      processedRows: 1000,
      processedBytes: 2048,
      wallTimeMillis: 1234,
      elapsedTimeMillis: 1500,
      peakMemoryBytes: 4096,
      nodes: 3,
    };
    expect(queryStatsSchema.parse(value)).toEqual(value);
  });

  it('rejects out-of-range progressPercentage', () => {
    const base = {
      state: 'RUNNING',
      queuedSplits: 0,
      runningSplits: 0,
      completedSplits: 0,
      totalSplits: 0,
      processedRows: 0,
      processedBytes: 0,
      wallTimeMillis: 0,
      elapsedTimeMillis: 0,
      peakMemoryBytes: 0,
    };
    expect(queryStatsSchema.safeParse({ ...base, progressPercentage: 150 }).success).toBe(false);
  });

  it('parses a QuerySnapshot', () => {
    const value = {
      queryId: 'q1',
      trinoQueryId: '20260612_100000_00001_abcde',
      infoUri: 'http://127.0.0.1:30080/ui/query.html?20260612',
      state: 'finished',
      columns: [{ name: 'n', type: 'bigint' }],
      rowCount: 1,
      truncated: false,
      submittedAt: ISO,
      finishedAt: ISO,
    };
    expect(querySnapshotSchema.parse(value)).toEqual(value);
  });

  it('defaults truncated to false when absent', () => {
    const value = {
      queryId: 'q1',
      state: 'finished',
      rowCount: 0,
      submittedAt: ISO,
    };
    expect(querySnapshotSchema.parse(value).truncated).toBe(false);
  });

  it('rejects a snapshot with an invalid state', () => {
    expect(
      querySnapshotSchema.safeParse({
        queryId: 'q1',
        state: 'done',
        rowCount: 0,
        submittedAt: ISO,
      }).success,
    ).toBe(false);
  });

  it('parses a QueryRowsPage', () => {
    const value = {
      offset: 0,
      rows: [
        ['a', 1],
        ['b', 2],
      ],
      totalBuffered: 2,
      complete: true,
    };
    expect(queryRowsPageSchema.parse(value)).toEqual(value);
  });

  it('parses a CreateQueryResponse', () => {
    expect(createQueryResponseSchema.parse({ queryId: 'q1' })).toEqual({ queryId: 'q1' });
  });

  it('parses a ResultSearchRequest and applies defaults', () => {
    const parsed = resultSearchRequestSchema.parse({
      search: 'tokyo',
      filters: [
        { columnIndex: 1, op: 'gte', value: '100' },
        { columnIndex: 2, op: 'isNull' },
      ],
      sort: { columnIndex: 0, dir: 'desc' },
    });
    expect(parsed.offset).toBe(0);
    expect(parsed.limit).toBe(100);
  });

  it('rejects a filter condition missing a required value', () => {
    expect(
      resultSearchRequestSchema.safeParse({
        filters: [{ columnIndex: 0, op: 'eq' }],
      }).success,
    ).toBe(false);
  });

  it('parses a ResultSearchPage', () => {
    const value = {
      offset: 0,
      rows: [['a', 1]],
      totalMatched: 1,
      totalRows: 10,
      complete: true,
    };
    expect(resultSearchPageSchema.parse(value)).toEqual(value);
  });

  it('parses a ResultProfile', () => {
    const value = {
      rowCount: 100,
      complete: true,
      columns: [
        {
          name: 'city',
          type: 'varchar',
          nullCount: 3,
          distinctCount: 12,
          distinctOverflow: false,
          min: 'akita',
          max: 'yokohama',
          topValues: [{ value: 'tokyo', count: 40 }],
        },
      ],
    };
    expect(resultProfileSchema.parse(value)).toEqual(value);
  });

  it('parses query export requests and responses', () => {
    expect(
      queryExportRequestSchema.parse({ destination: 's3', format: 'csv', gzip: true }),
    ).toEqual({
      destination: 's3',
      format: 'csv',
      gzip: true,
    });
    expect(
      queryExportRequestSchema.safeParse({ destination: 's3', format: 'xlsx', gzip: true }).success,
    ).toBe(false);
    expect(queryExportRequestSchema.parse({ destination: 'sheets' })).toEqual({
      destination: 'sheets',
    });
    expect(
      queryExportResponseSchema.parse({
        destination: 's3',
        objectKey: 'exports/alice/q1.csv',
        format: 'csv',
      }),
    ).toMatchObject({ destination: 's3' });
    expect(
      queryExportResponseSchema.parse({
        destination: 'sheets',
        spreadsheetId: 'sheet_1',
        url: 'https://docs.google.com/spreadsheets/d/sheet_1',
      }),
    ).toMatchObject({ destination: 'sheets' });
  });
});

describe('query guard estimate', () => {
  it('parses an EstimateRequest', () => {
    const value = { statement: 'SELECT * FROM nation', catalog: 'tpch', schema: 'tiny' };
    expect(estimateRequestSchema.parse(value)).toEqual(value);
  });

  it('rejects an empty statement', () => {
    expect(estimateRequestSchema.safeParse({ statement: '' }).success).toBe(false);
  });

  it('parses a full EstimateResult with null estimates', () => {
    const value = {
      status: 'unavailable',
      scanBytes: null,
      scanRows: null,
      outputRows: null,
      outputBytes: null,
      estimatedSeconds: null,
      tables: [],
      verdict: { decision: 'warn', reasons: ['Could not estimate scan cost'] },
      elapsedMs: 12,
    };
    expect(estimateResultSchema.parse(value)).toEqual(value);
  });

  it('parses an estimated result with per-table numbers', () => {
    const value = {
      status: 'estimated',
      scanBytes: 783988912,
      scanRows: 6001215,
      outputRows: 6001215,
      outputBytes: 783988912,
      estimatedSeconds: 7.8,
      tables: [
        { catalog: 'tpch', schema: 'sf1', table: 'lineitem', rows: 6001215, bytes: 783988912 },
        { catalog: 'system', schema: 'runtime', table: 'queries', rows: null, bytes: null },
      ],
      verdict: { decision: 'block', reasons: ['Estimated scan rows 6,001,215 exceeds limit'] },
      elapsedMs: 240,
    };
    expect(estimateResultSchema.parse(value)).toEqual(value);
  });

  it('rejects an unknown verdict decision', () => {
    const value = {
      status: 'estimated',
      scanBytes: 0,
      scanRows: 0,
      outputRows: 0,
      outputBytes: 0,
      estimatedSeconds: null,
      tables: [],
      verdict: { decision: 'deny', reasons: [] },
      elapsedMs: 0,
    };
    expect(estimateResultSchema.safeParse(value).success).toBe(false);
  });

  it('parses a GuardConfig and rejects an unknown mode', () => {
    const cfg = {
      mode: 'enforce',
      maxScanBytes: 1000,
      maxScanRows: 0,
      onUnknown: 'block',
      bytesPerSecond: 0,
    };
    expect(guardConfigSchema.parse(cfg)).toEqual(cfg);
    expect(guardConfigSchema.safeParse({ ...cfg, mode: 'strict' }).success).toBe(false);
  });

  it('builds the estimate route path', () => {
    expect(apiRoutes.queryEstimate()).toBe('/api/queries/estimate');
  });
});

describe('events (SSE discriminated union)', () => {
  const cases = [
    { type: 'state', state: 'running' },
    { type: 'columns', columns: [{ name: 'a', type: 'varchar' }] },
    { type: 'rows', offset: 0, rows: [[1], [2]] },
    {
      type: 'stats',
      stats: {
        state: 'RUNNING',
        queuedSplits: 0,
        runningSplits: 1,
        completedSplits: 0,
        totalSplits: 1,
        processedRows: 0,
        processedBytes: 0,
        wallTimeMillis: 0,
        elapsedTimeMillis: 0,
        peakMemoryBytes: 0,
      },
    },
    { type: 'error', error: { code: 'TRINO_ERROR', message: 'boom' } },
    { type: 'done', state: 'finished', rowCount: 5, truncated: false },
  ];

  it('parses each event variant', () => {
    for (const c of cases) {
      expect(queryEventSchema.safeParse(c).success).toBe(true);
    }
  });

  it('rejects an unknown event type', () => {
    expect(queryEventSchema.safeParse({ type: 'heartbeat' }).success).toBe(false);
  });

  it('rejects a rows event without offset', () => {
    expect(queryEventSchema.safeParse({ type: 'rows', rows: [[1]] }).success).toBe(false);
  });
});

describe('notebook', () => {
  const variable = {
    name: 'region',
    value: 'AMERICA',
    meta: {
      type: 'select',
      options: [{ label: 'Americas', value: 'AMERICA' }],
      placeholder: 'pick',
    },
  };
  const cell = {
    id: 'c1',
    kind: 'sql',
    source: 'SELECT * FROM nation',
    name: 'nations',
    collapsed: false,
    resultMeta: { state: 'finished', rowCount: 25, elapsedMs: 120, executedAt: ISO },
  };
  const notebook = {
    id: 'nb1',
    name: 'My Notebook',
    description: 'desc',
    cells: [cell],
    variables: [variable],
    context: { catalog: 'tpch', schema: 'tiny' },
    createdAt: ISO,
    updatedAt: ISO,
    revision: 1,
  };

  it('parses a Variable', () => {
    expect(variableSchema.parse(variable)).toEqual(variable);
  });

  it('rejects an invalid variable type', () => {
    expect(
      variableSchema.safeParse({ name: 'x', value: '', meta: { type: 'color' } }).success,
    ).toBe(false);
  });

  it('parses a Cell', () => {
    expect(cellSchema.parse(cell)).toEqual(cell);
  });

  it('rejects an invalid cell kind', () => {
    expect(cellSchema.safeParse({ id: 'c', kind: 'python', source: '' }).success).toBe(false);
  });

  it('parses a Notebook', () => {
    expect(notebookSchema.parse(notebook)).toEqual(notebook);
  });

  it('parses a CreateNotebookRequest with only a name', () => {
    expect(createNotebookRequestSchema.safeParse({ name: 'New' }).success).toBe(true);
  });

  it('rejects an UpdateNotebookRequest missing cells', () => {
    expect(
      updateNotebookRequestSchema.safeParse({
        name: 'n',
        description: '',
        variables: [],
        context: {},
      }).success,
    ).toBe(false);
  });
});

describe('savedQuery', () => {
  const value = {
    id: 's1',
    name: 'top nations',
    description: '',
    statement: 'SELECT * FROM nation',
    catalog: 'tpch',
    schema: 'tiny',
    isFavorite: true,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it('parses a SavedQuery', () => {
    expect(savedQuerySchema.parse(value)).toEqual(value);
  });

  it('rejects a create request with an empty statement', () => {
    expect(createSavedQueryRequestSchema.safeParse({ name: 'x', statement: '' }).success).toBe(
      false,
    );
  });
});

describe('history', () => {
  const entry = {
    id: 'h1',
    statement: 'SELECT 1',
    catalog: 'tpch',
    schema: 'tiny',
    trinoQueryId: '20260612_x',
    state: 'finished',
    rowCount: 1,
    elapsedMs: 10,
    submittedAt: ISO,
  };

  it('parses a QueryHistoryEntry', () => {
    expect(queryHistoryEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects a statement longer than 2000 chars', () => {
    expect(
      queryHistoryEntrySchema.safeParse({ ...entry, statement: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('parses a HistoryResponse', () => {
    const value = { items: [entry], offset: 0, limit: 50, total: 1 };
    expect(historyResponseSchema.parse(value)).toEqual(value);
  });
});

describe('schedule', () => {
  const run = {
    id: 'run_1',
    status: 'success',
    attempt: 1,
    trinoQueryId: '20260612_x',
    errorType: null,
    errorMessage: null,
    rowCount: 25,
    elapsedMs: 120,
    scheduledFor: ISO,
    startedAt: ISO,
    finishedAt: ISO,
  };
  const schedule = {
    id: 'sch_1',
    name: 'nightly',
    statement: 'SELECT 1',
    catalog: 'tpch',
    schema: 'tiny',
    cron: '0 0 * * *',
    enabled: true,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 },
    notifications: { onFailure: false, channels: [] },
    datasourceId: 'trino-default',
    createdAt: ISO,
    updatedAt: ISO,
    nextRunAt: ISO,
    lastRun: run,
  };

  it('parses a Schedule with a last run', () => {
    expect(scheduleSchema.parse(schedule)).toEqual(schedule);
  });

  it('parses a Schedule with null nextRunAt and lastRun', () => {
    const v = { ...schedule, nextRunAt: null, lastRun: null };
    expect(scheduleSchema.parse(v)).toEqual(v);
  });

  it('applies retry policy defaults', () => {
    expect(retryPolicySchema.parse({})).toEqual({
      maxAttempts: 3,
      backoffSeconds: 60,
      backoffMultiplier: 2,
    });
  });

  it('enforces retry policy bounds', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
    expect(retryPolicySchema.safeParse({ maxAttempts: 11 }).success).toBe(false);
    expect(retryPolicySchema.safeParse({ backoffSeconds: 3601 }).success).toBe(false);
    expect(retryPolicySchema.safeParse({ backoffMultiplier: 0 }).success).toBe(false);
  });

  it('applies notification defaults and rejects duplicate channels', () => {
    expect(scheduleNotificationsSchema.parse({})).toEqual({
      onFailure: false,
      channels: [],
    });
    expect(
      scheduleNotificationsSchema.safeParse({ onFailure: true, channels: ['slack', 'slack'] })
        .success,
    ).toBe(false);
  });

  it('requires email recipients when email notifications are selected', () => {
    expect(
      scheduleNotificationsSchema.safeParse({ onFailure: true, channels: ['email'] }).success,
    ).toBe(false);
    expect(
      scheduleNotificationsSchema.safeParse({
        onFailure: true,
        channels: ['email'],
        emailTo: [],
      }).success,
    ).toBe(false);
    expect(
      scheduleNotificationsSchema.safeParse({
        onFailure: true,
        channels: ['email'],
        emailTo: ['ops@example.com'],
      }).success,
    ).toBe(true);
  });

  it('limits email notification recipients to ten addresses', () => {
    const emailTo = Array.from({ length: 10 }, (_, i) => `ops${i}@example.com`);
    expect(
      scheduleNotificationsSchema.safeParse({
        onFailure: true,
        channels: ['email'],
        emailTo,
      }).success,
    ).toBe(true);
    expect(
      scheduleNotificationsSchema.safeParse({
        onFailure: true,
        channels: ['email'],
        emailTo: [...emailTo, 'extra@example.com'],
      }).success,
    ).toBe(false);
  });

  it('validates the cron shape (5 fields)', () => {
    expect(cronExpression.safeParse('* * * * *').success).toBe(true);
    expect(cronExpression.safeParse('*/5 0 * * 1-5').success).toBe(true);
    expect(cronExpression.safeParse('* * * *').success).toBe(false); // 4 fields
    expect(cronExpression.safeParse('* * * * * *').success).toBe(false); // 6 fields
    expect(cronExpression.safeParse('').success).toBe(false);
  });

  it('parses a CreateScheduleRequest and rejects an empty statement', () => {
    expect(
      createScheduleRequestSchema.safeParse({
        name: 'x',
        statement: 'SELECT 1',
        cron: '* * * * *',
        notifications: {
          onFailure: true,
          channels: ['email'],
          emailTo: ['ops@example.com'],
        },
      }).success,
    ).toBe(true);
    expect(
      createScheduleRequestSchema.safeParse({ name: 'x', statement: '', cron: '* * * * *' })
        .success,
    ).toBe(false);
  });

  it('rejects an empty UpdateScheduleRequest', () => {
    expect(updateScheduleRequestSchema.safeParse({}).success).toBe(false);
    expect(updateScheduleRequestSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('builds schedule route paths', () => {
    expect(apiRoutes.schedules()).toBe('/api/schedules');
    expect(apiRoutes.schedule('sch_1')).toBe('/api/schedules/sch_1');
    expect(apiRoutes.scheduleRun('sch_1')).toBe('/api/schedules/sch_1/run');
    expect(apiRoutes.scheduleRuns('sch_1')).toBe('/api/schedules/sch_1/runs');
  });
});

describe('routes', () => {
  it('builds parameterized paths', () => {
    expect(apiRoutes.queryRows('q1')).toBe('/api/queries/q1/rows');
    expect(apiRoutes.queryDownloadXlsx('q1')).toBe('/api/queries/q1/download.xlsx');
    expect(apiRoutes.queryExport('q1')).toBe('/api/queries/q1/export');
    expect(apiRoutes.table('tpch', 'tiny', 'nation')).toBe(
      '/api/catalogs/tpch/schemas/tiny/tables/nation',
    );
  });

  it('encodes path segments', () => {
    expect(apiRoutes.notebook('a/b')).toBe('/api/notebooks/a%2Fb');
    expect(apiRoutes.schemas('cat with space')).toBe('/api/catalogs/cat%20with%20space/schemas');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowDefinitionSchema } from '@hubble/contracts';
import { loadServerConfig } from '../config';
import { NotebookRepository } from '../store/notebooks';
import { SavedQueryRepository } from '../store/savedQueries';
import { DocumentShareRepository } from '../store/documentShares';
import { WorkflowRepository } from '../store/workflows';
import { dbBackends } from '../test/dbBackends';
import {
  contentHash,
  notebookToContent,
  savedQueryToContent,
  workflowToContent,
} from './canonical';
import { DocumentGitLinkRepository } from './store';
import { GithubGovernanceService, statementApprovalKey } from './governance';

const KEY = Buffer.alloc(32, 4);
const GITHUB_ENV = {
  GITHUB_REPO: 'acme/hubble-docs',
  GITHUB_APP_CLIENT_ID: 'cid',
  GITHUB_APP_CLIENT_SECRET: 'sec',
  GITHUB_TOKEN_ENCRYPTION_KEY: KEY.toString('base64'),
};
const DEFAULT_DATASOURCE_ID = 'trino-default';

function approvalContext(
  statement: string,
  context: { datasourceId?: string; catalog?: string; schema?: string } = {},
) {
  return { statement, defaultDatasourceId: DEFAULT_DATASOURCE_ID, ...context };
}

function governanceConfig(governance: 'off' | 'on' = 'on') {
  return { ...loadServerConfig(GITHUB_ENV).github, governance };
}

async function buildGovernance(
  db: Awaited<ReturnType<(typeof dbBackends)[0]['open']>>,
  options: { governance?: 'off' | 'on'; now?: () => number } = {},
) {
  const shares = new DocumentShareRepository(db);
  const savedQueries = new SavedQueryRepository(db, shares);
  const notebooks = new NotebookRepository(db, shares);
  const workflows = new WorkflowRepository(db);
  const links = new DocumentGitLinkRepository(db);
  const service = new GithubGovernanceService({
    config: governanceConfig(options.governance ?? 'on'),
    links,
    savedQueries,
    notebooks,
    workflows,
    now: options.now,
  });
  return { service, savedQueries, notebooks, workflows, links };
}

describe.each(dbBackends)('GithubGovernanceService ($name)', ({ open }) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for all checks when governance is disabled', async () => {
    const db = await open();
    const { service, workflows } = await buildGovernance(db, { governance: 'off' });
    expect(service.enabled).toBe(false);
    expect(await service.isStatementApproved(approvalContext('SELECT 999'))).toBe(true);
    const workflow = await workflows.create('alice', {
      name: 'WF',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st1', name: 'S', statement: 'SELECT 1' }] },
      ]),
      datasourceId: 'trino-default',
    });
    expect(await service.isWorkflowApproved(workflow)).toBe(true);
    await db.close();
  });

  it('approves statements from approved saved query, notebook cell, and workflow step', async () => {
    const db = await open();
    const { service, savedQueries, notebooks, workflows, links } = await buildGovernance(db);
    const accessor = { user: 'alice', groups: [] as string[], role: 'admin' };

    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    const savedDoc = (await savedQueries.get(accessor, saved.id))!;
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });

    const notebook = await notebooks.create('alice', {
      name: 'NB',
      cells: [{ id: 'cell1', kind: 'sql', source: 'SELECT nb' }],
    });
    const nbDoc = (await notebooks.get(accessor, notebook.id))!;
    await links.upsert('notebook', notebook.id, {
      path: `notebooks/${notebook.id}.yaml`,
      approvedHash: contentHash(notebookToContent(nbDoc)),
    });

    const workflow = await workflows.create('alice', {
      name: 'WF',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st1', name: 'S', statement: 'SELECT wf' }] },
      ]),
      datasourceId: 'trino-default',
    });
    await links.upsert('workflow', workflow.id, {
      path: `workflows/${workflow.id}.yaml`,
      approvedHash: contentHash(workflowToContent(workflow)),
    });

    // キャッシュは初回参照時に構築されるため、全承認リンクを先に用意してから判定する。
    expect(await service.isStatementApproved(approvalContext('SELECT 1'))).toBe(true);
    expect(await service.isStatementApproved(approvalContext('SELECT 1   '))).toBe(true);
    expect(await service.isStatementApproved(approvalContext('SELECT nb'))).toBe(true);
    expect(await service.isStatementApproved(approvalContext('SELECT wf'))).toBe(true);
    expect(await service.isWorkflowApproved(workflow)).toBe(true);
    await db.close();
  });

  it('rejects statements after local document modification (once TTL expires)', async () => {
    const db = await open();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { service, savedQueries, links } = await buildGovernance(db, {
      now: () => now,
    });
    const accessor = { user: 'alice', groups: [] as string[], role: 'admin' };
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    const savedDoc = (await savedQueries.get(accessor, saved.id))!;
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });
    expect(await service.isStatementApproved(approvalContext('SELECT 1'))).toBe(true);

    await savedQueries.update(accessor, saved.id, {
      name: 'Q',
      description: '',
      statement: 'SELECT 2',
      isFavorite: false,
    });
    // TTL 切れ後の再構築で、ローカル変更されたドキュメントのステートメントは除外される。
    now += 61_000;
    expect(await service.isStatementApproved(approvalContext('SELECT 1'))).toBe(false);
    expect(await service.isStatementApproved(approvalContext('SELECT 2'))).toBe(false);
    await db.close();
  });

  it('serves stale cache within TTL and refreshes after TTL', async () => {
    const db = await open();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { service, savedQueries, links } = await buildGovernance(db, {
      now: () => now,
    });
    const accessor = { user: 'alice', groups: [] as string[], role: 'admin' };
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    const savedDoc = (await savedQueries.get(accessor, saved.id))!;
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });
    expect(await service.isStatementApproved(approvalContext('SELECT 1'))).toBe(true);

    await savedQueries.update(accessor, saved.id, {
      name: 'Q',
      description: '',
      statement: 'SELECT 2',
      isFavorite: false,
    });
    // TTL 内は古いキャッシュのまま (DB アクセスなし)。編集は最大 60 秒反映されない。
    expect(await service.isStatementApproved(approvalContext('SELECT 1'))).toBe(true);
    expect(await service.isStatementApproved(approvalContext('SELECT 2'))).toBe(false);

    // TTL 切れ + 更新後ドキュメントの再承認で新しいステートメントが承認済みになる。
    const updatedDoc = (await savedQueries.get(accessor, saved.id))!;
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(updatedDoc)),
    });
    now += 61_000;
    expect(await service.isStatementApproved(approvalContext('SELECT 1'))).toBe(false);
    expect(await service.isStatementApproved(approvalContext('SELECT 2'))).toBe(true);
    await db.close();
  });

  it('falls back to previous cache when rebuild fails', async () => {
    const db = await open();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { service, savedQueries, links } = await buildGovernance(db, {
      now: () => now,
    });
    const accessor = { user: 'alice', groups: [] as string[], role: 'admin' };
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT cached',
    });
    const savedDoc = (await savedQueries.get(accessor, saved.id))!;
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });
    expect(await service.isStatementApproved(approvalContext('SELECT cached'))).toBe(true);

    now += 61_000;
    vi.spyOn(links, 'listApproved').mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await service.isStatementApproved(approvalContext('SELECT cached'))).toBe(true);
    expect(warn).toHaveBeenCalled();
    await db.close();
  });

  it('binds approved saved queries to datasource, catalog, and schema', async () => {
    const db = await open();
    const { service, savedQueries, links } = await buildGovernance(db);
    const accessor = { user: 'alice', groups: [] as string[], role: 'admin' };
    const saved = await savedQueries.create('alice', {
      name: 'Scoped query',
      statement: 'SELECT scoped',
      datasourceId: 'trino-primary',
      catalog: 'sales',
      schema: 'reporting',
    });
    const savedDoc = (await savedQueries.get(accessor, saved.id))!;
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });

    expect(
      await service.isStatementApproved(
        approvalContext('SELECT scoped', {
          datasourceId: 'trino-primary',
          catalog: 'sales',
          schema: 'reporting',
        }),
      ),
    ).toBe(true);
    expect(
      await service.isStatementApproved(
        approvalContext('SELECT scoped', {
          datasourceId: 'trino-secondary',
          catalog: 'sales',
          schema: 'reporting',
        }),
      ),
    ).toBe(false);
    expect(
      await service.isStatementApproved(
        approvalContext('SELECT scoped', {
          datasourceId: 'trino-primary',
          catalog: 'finance',
          schema: 'reporting',
        }),
      ),
    ).toBe(false);
    expect(
      await service.isStatementApproved(
        approvalContext('SELECT scoped', {
          datasourceId: 'trino-primary',
          catalog: 'sales',
          schema: 'private',
        }),
      ),
    ).toBe(false);
    await db.close();
  });

  it('resolves omitted datasource context with the current default on both sides', async () => {
    const db = await open();
    const { service, savedQueries, links } = await buildGovernance(db);
    const accessor = { user: 'alice', groups: [] as string[], role: 'admin' };
    const saved = await savedQueries.create('alice', {
      name: 'Default query',
      statement: 'SELECT default_context',
    });
    const savedDoc = (await savedQueries.get(accessor, saved.id))!;
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });

    expect(
      await service.isStatementApproved({
        statement: 'SELECT default_context',
        defaultDatasourceId: 'trino-before-reload',
      }),
    ).toBe(true);
    expect(
      await service.isStatementApproved({
        statement: 'SELECT default_context',
        defaultDatasourceId: 'trino-after-reload',
      }),
    ).toBe(true);
    expect(
      await service.isStatementApproved({
        datasourceId: 'trino-before-reload',
        statement: 'SELECT default_context',
        defaultDatasourceId: 'trino-after-reload',
      }),
    ).toBe(false);
    await db.close();
  });

  it('normalizes trailing statement whitespace without collapsing execution context', () => {
    expect(statementApprovalKey(approvalContext('SELECT 1\n  '))).toBe(
      statementApprovalKey(approvalContext('SELECT 1\n')),
    );
    expect(statementApprovalKey(approvalContext('SELECT 1', { catalog: 'catalog-a' }))).not.toBe(
      statementApprovalKey(approvalContext('SELECT 1', { catalog: 'catalog-b' })),
    );
  });
});

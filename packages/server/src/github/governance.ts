/**
 * GitHub ガバナンス強制の判定サービス。
 *
 * `GITHUB_GOVERNANCE=on` のとき、承認済みでないドキュメント由来の実行に対し
 * 結果永続化の制限と cron 実行の承認必須化を行う。approved_hash の鮮度更新は
 * フェーズ 1 の status 参照時 TTL 更新に任せ、ここでは GitHub API を呼ばない。
 */
import { createHash } from 'node:crypto';
import type { DocumentGitType, Notebook, SavedQuery } from '@hubble/contracts';
import type { GithubConfig } from '../config';
import { contentHash, documentToContent, workflowToContent } from './canonical';
import type { DocumentGitLinkRecord, DocumentGitLinkRepository } from './store';
import type { NotebookRepository } from '../store/notebooks';
import type { SavedQueryRepository } from '../store/savedQueries';
import type { WorkflowRecord, WorkflowRepository } from '../store/workflows';

const APPROVED_STATEMENTS_TTL_MS = 60_000;

/** ステートメント承認を実行先contextへ束縛する入力。 */
export interface StatementApprovalContext {
  datasourceId?: string;
  catalog?: string;
  schema?: string;
  statement: string;
  defaultDatasourceId: string;
}

/** 正規化した実行contextとステートメントから承認判定用SHA-256を作る。 */
export function statementApprovalKey(context: StatementApprovalContext): string {
  const normalized = [
    context.datasourceId ?? context.defaultDatasourceId,
    context.catalog ?? '',
    context.schema ?? '',
    context.statement.trimEnd(),
  ];
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

export interface GithubGovernanceServiceDeps {
  config: GithubConfig;
  links: DocumentGitLinkRepository;
  savedQueries: SavedQueryRepository;
  notebooks: NotebookRepository;
  workflows: WorkflowRepository;
  now?: () => number;
}

/**
 * GitHub ガバナンスの判定ロジック。
 * governance off または GitHub 無効時は enabled=false となり、全判定が true を返す no-op として動く。
 */
export class GithubGovernanceService {
  private readonly now: () => number;
  private approvedStatements = new Set<string>();
  private approvedStatementsBuiltAt = 0;
  private approvedStatementsPromise: Promise<void> | undefined;
  private lastSuccessfulApprovedStatements: Set<string> | undefined;
  private approvedStatementsDefaultDatasourceId: string | undefined;
  private lastSuccessfulDefaultDatasourceId: string | undefined;

  constructor(private readonly deps: GithubGovernanceServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** ガバナンス強制が有効か。 */
  get enabled(): boolean {
    return this.deps.config.enabled && this.deps.config.governance === 'on';
  }

  /** ワークフローが GitHub 承認済みか。無効時は常に true。 */
  async isWorkflowApproved(workflow: WorkflowRecord): Promise<boolean> {
    if (!this.enabled) return true;
    const link = await this.deps.links.get('workflow', workflow.id);
    if (!link?.approvedHash) return false;
    const currentHash = contentHash(workflowToContent(workflow));
    return currentHash === link.approvedHash;
  }

  /**
   * 対話クエリのステートメントが承認済み集合に含まれるか。無効時は常に true。
   *
   * 承認済み集合は TTL 60 秒のキャッシュで、TTL 内は DB へ一切アクセスしない。
   * そのためドキュメントの編集や承認状態の変化がこの判定へ反映されるまで
   * 最大 60 秒の遅延がある (submit 経路に追加コストを載せないための設計判断)。
   */
  async isStatementApproved(context: StatementApprovalContext): Promise<boolean> {
    if (!this.enabled) return true;
    await this.ensureApprovedStatements(context.defaultDatasourceId);
    return this.approvedStatements.has(statementApprovalKey(context));
  }

  /**
   * 承認済みステートメント集合を TTL に従って構築する。
   * TTL 内はキャッシュをそのまま使い (DB アクセスなし)、TTL 切れ時のみ再構築する。
   * 構築中の並行呼び出しは同じ Promise を共有する (サンダリングハード防止)。
   */
  private async ensureApprovedStatements(defaultDatasourceId: string): Promise<void> {
    const nowMs = this.now();
    if (
      this.approvedStatementsDefaultDatasourceId === defaultDatasourceId &&
      this.approvedStatementsBuiltAt > 0 &&
      nowMs - this.approvedStatementsBuiltAt < APPROVED_STATEMENTS_TTL_MS
    ) {
      return;
    }
    if (this.approvedStatementsPromise) {
      await this.approvedStatementsPromise;
      if (this.approvedStatementsDefaultDatasourceId !== defaultDatasourceId) {
        await this.ensureApprovedStatements(defaultDatasourceId);
      }
      return;
    }
    this.approvedStatementsPromise = this.buildApprovedStatements(
      nowMs,
      defaultDatasourceId,
    ).finally(() => {
      this.approvedStatementsPromise = undefined;
    });
    await this.approvedStatementsPromise;
  }

  private async buildApprovedStatements(nowMs: number, defaultDatasourceId: string): Promise<void> {
    try {
      const links = await this.deps.links.listApproved();
      const next = new Set<string>();
      for (const link of links) {
        const contexts = await this.statementsForApprovedLink(link, defaultDatasourceId);
        for (const context of contexts) {
          next.add(statementApprovalKey(context));
        }
      }
      this.approvedStatements = next;
      this.approvedStatementsBuiltAt = nowMs;
      this.approvedStatementsDefaultDatasourceId = defaultDatasourceId;
      this.lastSuccessfulApprovedStatements = new Set(next);
      this.lastSuccessfulDefaultDatasourceId = defaultDatasourceId;
    } catch (err) {
      console.warn(
        'failed to build approved statement cache; using previous cache if available',
        err,
      );
      // 同じ既定datasourceの前回cacheだけを再利用し、異なる既定値の承認は流用しない。
      this.approvedStatements =
        this.lastSuccessfulApprovedStatements &&
        this.lastSuccessfulDefaultDatasourceId === defaultDatasourceId
          ? new Set(this.lastSuccessfulApprovedStatements)
          : new Set();
      this.approvedStatementsBuiltAt = nowMs;
      this.approvedStatementsDefaultDatasourceId = defaultDatasourceId;
    }
  }

  private async statementsForApprovedLink(
    link: DocumentGitLinkRecord,
    defaultDatasourceId: string,
  ): Promise<StatementApprovalContext[]> {
    const doc = await this.loadDocument(link.documentType, link.documentId);
    if (!doc) return [];
    const currentHash = contentHash(documentToContent(link.documentType, doc));
    if (currentHash !== link.approvedHash) return [];

    switch (link.documentType) {
      case 'saved_query':
        return [
          {
            datasourceId: (doc as SavedQuery).datasourceId,
            catalog: (doc as SavedQuery).catalog,
            schema: (doc as SavedQuery).schema,
            statement: (doc as SavedQuery).statement,
            defaultDatasourceId,
          },
        ];
      case 'notebook': {
        const notebook = doc as Notebook;
        return notebook.cells
          .filter((cell) => cell.kind === 'sql')
          .map((cell) => ({
            datasourceId: notebook.context.datasourceId,
            catalog: notebook.context.catalog,
            schema: notebook.context.schema,
            statement: cell.source,
            defaultDatasourceId,
          }));
      }
      case 'workflow': {
        const workflow = doc as WorkflowRecord;
        const contexts: StatementApprovalContext[] = [];
        for (const stage of workflow.stages) {
          for (const step of stage.steps) {
            contexts.push({
              datasourceId: step.datasourceId ?? workflow.datasourceId,
              catalog: step.catalog,
              schema: step.schema,
              statement: step.statement,
              defaultDatasourceId,
            });
          }
        }
        return contexts;
      }
      case 'alert':
        return [];
      case 'dashboard':
        return [];
    }
  }

  private async loadDocument(
    type: DocumentGitType,
    id: string,
  ): Promise<SavedQuery | Notebook | WorkflowRecord | undefined> {
    switch (type) {
      case 'saved_query':
        return this.deps.savedQueries.getByIdUnscoped(id);
      case 'notebook':
        return this.deps.notebooks.getByIdUnscoped(id);
      case 'workflow':
        return this.deps.workflows.getById(id);
      case 'alert':
        return undefined;
      case 'dashboard':
        return undefined;
    }
  }
}

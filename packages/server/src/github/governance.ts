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

/** ステートメント文字列の承認判定用 SHA-256 (hex)。末尾空白は trimEnd する。 */
export function statementHash(statement: string): string {
  return createHash('sha256').update(statement.trimEnd(), 'utf8').digest('hex');
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
  async isStatementApproved(statement: string): Promise<boolean> {
    if (!this.enabled) return true;
    await this.ensureApprovedStatements();
    return this.approvedStatements.has(statementHash(statement));
  }

  /**
   * 承認済みステートメント集合を TTL に従って構築する。
   * TTL 内はキャッシュをそのまま使い (DB アクセスなし)、TTL 切れ時のみ再構築する。
   * 構築中の並行呼び出しは同じ Promise を共有する (サンダリングハード防止)。
   */
  private async ensureApprovedStatements(): Promise<void> {
    const nowMs = this.now();
    if (
      this.approvedStatementsBuiltAt > 0 &&
      nowMs - this.approvedStatementsBuiltAt < APPROVED_STATEMENTS_TTL_MS
    ) {
      return;
    }
    if (this.approvedStatementsPromise) {
      await this.approvedStatementsPromise;
      return;
    }
    this.approvedStatementsPromise = this.buildApprovedStatements(nowMs).finally(() => {
      this.approvedStatementsPromise = undefined;
    });
    await this.approvedStatementsPromise;
  }

  private async buildApprovedStatements(nowMs: number): Promise<void> {
    try {
      const links = await this.deps.links.listApproved();
      const next = new Set<string>();
      for (const link of links) {
        const statements = await this.statementsForApprovedLink(link);
        for (const statement of statements) {
          next.add(statementHash(statement));
        }
      }
      this.approvedStatements = next;
      this.approvedStatementsBuiltAt = nowMs;
      this.lastSuccessfulApprovedStatements = new Set(next);
    } catch (err) {
      console.warn(
        'failed to build approved statement cache; using previous cache if available',
        err,
      );
      // フェイルクローズにしない: 前回成功時のキャッシュがあればそれを使い、なければ空集合。
      this.approvedStatements = this.lastSuccessfulApprovedStatements
        ? new Set(this.lastSuccessfulApprovedStatements)
        : new Set();
      this.approvedStatementsBuiltAt = nowMs;
    }
  }

  private async statementsForApprovedLink(link: DocumentGitLinkRecord): Promise<string[]> {
    const doc = await this.loadDocument(link.documentType, link.documentId);
    if (!doc) return [];
    const currentHash = contentHash(documentToContent(link.documentType, doc));
    if (currentHash !== link.approvedHash) return [];

    switch (link.documentType) {
      case 'saved_query':
        return [(doc as SavedQuery).statement];
      case 'notebook': {
        const notebook = doc as Notebook;
        return notebook.cells.filter((cell) => cell.kind === 'sql').map((cell) => cell.source);
      }
      case 'workflow': {
        const workflow = doc as WorkflowRecord;
        const statements: string[] = [];
        for (const stage of workflow.stages) {
          for (const step of stage.steps) {
            statements.push(step.statement);
          }
        }
        return statements;
      }
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
    }
  }
}

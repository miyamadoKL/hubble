/**
 * GitHub へ push するドキュメントの正規形シリアライズと承認判定用ハッシュ。
 *
 * 揮発フィールド (タイムスタンプ、所有者、実行結果メタ等) を含めず、
 * 同一内容なら同一ハッシュになる純粋関数群を提供する。
 */
import { createHash } from 'node:crypto';
import { stringify as stringifyYaml } from 'yaml';
import type { Notebook, SavedQuery } from '@hubble/contracts';
import type { DocumentGitType } from '@hubble/contracts';
import type { WorkflowRecord } from '../store/workflows';

/** 正規形 SQL/YAML 文字列の SHA-256 ハッシュ (hex)。 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 保存済みクエリを .sql 正規形へ変換する。
 * @param q - 保存済みクエリ。
 */
export function savedQueryToContent(q: SavedQuery): string {
  const headerLines: string[] = [`-- name: ${q.name}`];
  if (q.description) {
    headerLines.push(`-- description: ${q.description}`);
  }
  if (q.datasourceId) {
    headerLines.push(`-- datasource: ${q.datasourceId}`);
  }
  if (q.catalog) {
    headerLines.push(`-- catalog: ${q.catalog}`);
  }
  if (q.schema) {
    headerLines.push(`-- schema: ${q.schema}`);
  }
  const body = q.statement.replace(/\s+$/, '');
  return `${headerLines.join('\n')}\n\n${body}\n`;
}

/**
 * ノートブックを YAML 正規形へ変換する。
 * @param nb - ノートブック。
 */
export function notebookToContent(nb: Notebook): string {
  const payload = {
    id: nb.id,
    name: nb.name,
    description: nb.description,
    context: nb.context,
    variables: nb.variables.map((v) => ({
      name: v.name,
      value: v.value,
      meta: v.meta,
    })),
    cells: nb.cells.map((cell) => {
      const item: Record<string, unknown> = {
        kind: cell.kind,
        source: cell.source,
      };
      if (cell.name !== undefined) item.name = cell.name;
      if (cell.collapsed !== undefined) item.collapsed = cell.collapsed;
      // チャート設定はユーザーが編集するコンテンツなので正規形に含める
      // (resultMeta のような実行結果由来の揮発フィールドは含めない)。
      if (cell.chart !== undefined) item.chart = cell.chart;
      return item;
    }),
  };
  return `${stringifyYaml(payload)}\n`;
}

/**
 * ワークフローを YAML 正規形へ変換する。
 * @param w - ワークフローレコード。
 */
export function workflowToContent(w: WorkflowRecord): string {
  const payload = {
    id: w.id,
    name: w.name,
    description: w.description,
    datasourceId: w.datasourceId,
    cron: w.cron,
    retry: w.retry,
    stages: w.stages.map((stage) => ({
      steps: stage.steps.map((step) => {
        const item: Record<string, unknown> = {
          id: step.id,
          name: step.name,
          statement: step.statement,
          onFailure: step.onFailure,
        };
        if (step.datasourceId !== undefined) item.datasourceId = step.datasourceId;
        if (step.catalog !== undefined) item.catalog = step.catalog;
        if (step.schema !== undefined) item.schema = step.schema;
        return item;
      }),
    })),
  };
  return `${stringifyYaml(payload)}\n`;
}

/**
 * ドキュメント種別と id から Git リポジトリ内パスを返す。
 * @param type - ドキュメント種別。
 * @param id - ドキュメント id。
 */
export function documentPath(type: DocumentGitType, id: string): string {
  switch (type) {
    case 'saved_query':
      return `saved-queries/${id}.sql`;
    case 'notebook':
      return `notebooks/${id}.yaml`;
    case 'workflow':
      return `workflows/${id}.yaml`;
  }
}

/**
 * push 用 feature ブランチ名を生成する。
 * @param user - Hubble principal user。
 * @param type - ドキュメント種別。
 * @param id - ドキュメント id。
 */
export function branchNameFor(user: string, type: DocumentGitType, id: string): string {
  const sanitized = user.replace(/[^a-zA-Z0-9-]/g, '-');
  return `hubble/${sanitized}/${type}-${id}`;
}

/**
 * ドキュメント種別に応じた正規形文字列を返す。
 * @param type - ドキュメント種別。
 * @param doc - ドキュメント本体。
 */
export function documentToContent(
  type: DocumentGitType,
  doc: SavedQuery | Notebook | WorkflowRecord,
): string {
  switch (type) {
    case 'saved_query':
      return savedQueryToContent(doc as SavedQuery);
    case 'notebook':
      return notebookToContent(doc as Notebook);
    case 'workflow':
      return workflowToContent(doc as WorkflowRecord);
  }
}

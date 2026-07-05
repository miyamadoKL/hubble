/**
 * ワークフロー run 一括エクスポート対象の run とステップを解決する。
 */
import type { Principal } from '../auth/principal';
import { AppError } from '../errors';
import { roleAllowsDatasource } from '../rbac/check';
import type { Services } from '../services';
import { buildSheetNames, buildZipEntryNames } from './exportNames';

/** 永続化済み結果を持つエクスポート対象ステップ。 */
export interface ExportableWorkflowStep {
  stepRunId: string;
  stepId: string;
  stageIndex: number;
  name: string;
  datasourceId: string;
  resultObjectKey: string;
}

/** 一括エクスポート用に解決した run 情報。 */
export interface ResolvedWorkflowRunExport {
  runId: string;
  workflowId: string;
  steps: ExportableWorkflowStep[];
  zipEntries: Array<{ step: ExportableWorkflowStep; entryName: string }>;
  sheets: Array<{ step: ExportableWorkflowStep; name: string }>;
}

/**
 * 完了済み run から永続化済みステップ結果を解決する。
 * owner 不一致は 404、実行中は 409、永続化対象なしは RESULT_NOT_PERSISTED。
 */
export async function resolveWorkflowRunExport(
  services: Services,
  runId: string,
  principal: Principal,
): Promise<ResolvedWorkflowRunExport> {
  const run = await services.workflowRuns.getRun(runId);
  if (!run || run.owner !== principal.user) {
    throw AppError.notFound(`Workflow run ${runId} not found`);
  }
  if (run.status === 'running') {
    throw AppError.conflict('Workflow run is still in progress');
  }
  if (!services.resultStore.enabled) {
    throw new AppError(404, {
      code: 'RESULT_NOT_PERSISTED',
      message: 'Result persistence is disabled',
    });
  }

  const steps: ExportableWorkflowStep[] = [];
  for (const step of run.steps) {
    if (step.status !== 'success') continue;
    const detail = await services.workflowRuns.getStepRun(runId, step.id);
    if (!detail?.resultObjectKey || !detail.resultExpiresAt) continue;
    if (new Date(detail.resultExpiresAt).getTime() <= Date.now()) continue;
    steps.push({
      stepRunId: step.id,
      stepId: step.stepId,
      stageIndex: step.stageIndex,
      name: step.name,
      datasourceId: step.datasourceId,
      resultObjectKey: detail.resultObjectKey,
    });
  }

  if (steps.length === 0) {
    throw new AppError(404, {
      code: 'RESULT_NOT_PERSISTED',
      message: 'No persisted step results are available for this workflow run',
    });
  }

  for (const step of steps) {
    if (roleAllowsDatasource(principal.role, step.datasourceId)) continue;
    throw AppError.forbidden(`Access denied for datasource: ${step.datasourceId}`, 'FORBIDDEN');
  }

  const zipNames = buildZipEntryNames(steps);
  const sheetNames = buildSheetNames(steps);
  return {
    runId,
    workflowId: run.workflowId,
    steps,
    zipEntries: steps.map((step, index) => ({
      step,
      entryName: zipNames[index]!,
    })),
    sheets: steps.map((step, index) => ({
      step,
      name: sheetNames[index]!,
    })),
  };
}

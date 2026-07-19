/**
 * workflowFormat.ts の純粋関数のテスト。
 * ドラフトの差分判定、保存可否の検証、リクエスト変換 (空ステージ除去)、
 * ステータスのトーン変換、次回実行の相対表示を確認する。
 */
import { describe, expect, it } from 'vitest';
import type { Workflow } from '@hubble/contracts';
import {
  blankDraft,
  blankStep,
  draftEquals,
  draftFromWorkflow,
  draftProblem,
  draftToCreateRequest,
  draftToUpdateRequest,
  nextRunLabel,
  runStatusTone,
  stepStatusTone,
  totalSteps,
  triggerLabel,
} from './workflowFormat';

// テスト用のワークフローを組み立てるヘルパー。
function sampleWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wfl_1',
    name: 'Morning report',
    description: '',
    stages: [
      { steps: [{ id: 'st_a', name: 'Build', statement: 'SELECT 1', onFailure: 'stop' }] },
      {
        steps: [
          { id: 'st_b', name: 'Report A', statement: 'SELECT 2', onFailure: 'continue' },
          { id: 'st_c', name: 'Report B', statement: 'SELECT 3', onFailure: 'continue' },
        ],
      },
    ],
    datasourceId: 'trino-main',
    cron: '0 7 * * *',
    enabled: true,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 },
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    nextRunAt: null,
    lastRun: null,
    ...overrides,
  };
}

describe('draftFromWorkflow / draftEquals', () => {
  it('往復したドラフトは等しく、編集すると等しくなくなる', () => {
    const workflow = sampleWorkflow();
    const a = draftFromWorkflow(workflow);
    const b = draftFromWorkflow(workflow);
    expect(draftEquals(a, b)).toBe(true);

    b.stages[0]!.steps[0]!.statement = 'SELECT 42';
    expect(draftEquals(a, b)).toBe(false);
  });

  it('deep copy であり元のワークフローを変更しない', () => {
    const workflow = sampleWorkflow();
    const draft = draftFromWorkflow(workflow);
    draft.stages[0]!.steps[0]!.name = 'changed';
    expect(workflow.stages[0]!.steps[0]!.name).toBe('Build');
  });
});

describe('draftProblem', () => {
  it('名前が空なら保存不可', () => {
    const draft = draftFromWorkflow(sampleWorkflow());
    draft.name = ' ';
    expect(draftProblem(draft)).toMatch(/name/);
  });

  it('ステップが 1 つも無ければ保存不可', () => {
    const draft = blankDraft('trino-main');
    draft.name = 'x';
    expect(draftProblem(draft)).toMatch(/at least one step/);
  });

  it('名前か SQL が空のステップがあれば保存不可', () => {
    const draft = draftFromWorkflow(sampleWorkflow());
    draft.stages[1]!.steps[0]!.statement = '';
    expect(draftProblem(draft)).toMatch(/Report A/);
  });

  it('完全なドラフトは保存可能 (null)', () => {
    expect(draftProblem(draftFromWorkflow(sampleWorkflow()))).toBeNull();
  });

  // レビュー指摘: draftProblem() は以前 locale を無視して英語文言を生で返していた
  // (WorkflowView.tsx のタイトル属性にそのまま表示されていた)。ja ロケールで
  // 実際に翻訳済みメッセージが返ることを固定する。
  it('ja ロケールでは日本語の不備メッセージを返す', () => {
    const nameEmpty = draftFromWorkflow(sampleWorkflow());
    nameEmpty.name = ' ';
    expect(draftProblem(nameEmpty, 'ja')).toBe('ワークフローに名前を付けてください。');

    const noSteps = blankDraft('trino-main');
    noSteps.name = 'x';
    expect(draftProblem(noSteps, 'ja')).toBe('ステップを少なくとも 1 つ追加してください。');

    const missingStatement = draftFromWorkflow(sampleWorkflow());
    missingStatement.stages[1]!.steps[0]!.statement = '';
    expect(draftProblem(missingStatement, 'ja')).toBe(
      'ステップ「Report A」には名前と SQL 文が必要です。',
    );

    const untitledStep = draftFromWorkflow(sampleWorkflow());
    untitledStep.stages[0]!.steps[0]!.name = '   ';
    expect(draftProblem(untitledStep, 'ja')).toBe(
      'ステップ「無題のステップ」には名前と SQL 文が必要です。',
    );
  });
});

describe('draftToCreateRequest / draftToUpdateRequest', () => {
  it('空ステージを除去して送る', () => {
    const draft = draftFromWorkflow(sampleWorkflow());
    draft.stages.push({ steps: [] });
    expect(draftToCreateRequest(draft).stages).toHaveLength(2);
    expect(draftToUpdateRequest(draft).stages).toHaveLength(2);
  });

  it('名前を trim して cron/enabled を引き継ぐ', () => {
    const draft = draftFromWorkflow(sampleWorkflow());
    draft.name = '  Daily  ';
    const req = draftToCreateRequest(draft);
    expect(req.name).toBe('Daily');
    expect(req.cron).toBe('0 7 * * *');
    expect(req.enabled).toBe(true);
  });
});

describe('blankStep / totalSteps', () => {
  it('blankStep は一意な id を持ち onFailure は stop', () => {
    const a = blankStep();
    const b = blankStep();
    expect(a.id).not.toBe(b.id);
    expect(a.onFailure).toBe('stop');
  });

  it('totalSteps は全ステージのステップ数を合算する', () => {
    expect(totalSteps(draftFromWorkflow(sampleWorkflow()))).toBe(3);
  });
});

describe('ステータスのトーン変換', () => {
  it('run: partial は warning、failed は error', () => {
    expect(runStatusTone('partial')).toBe('warning');
    expect(runStatusTone('failed')).toBe('error');
    expect(runStatusTone('running')).toBe('running');
  });

  it('step: blocked は error、skipped は neutral', () => {
    expect(stepStatusTone('blocked')).toBe('error');
    expect(stepStatusTone('skipped')).toBe('neutral');
  });
});

describe('triggerLabel', () => {
  // レビュー指摘: WorkflowRunsModal の run 行が trigger (manual/cron) という
  // 契約値をそのまま生表示していた。ja ロケールで翻訳済みラベルになることを固定する。
  it('ja ロケールで manual/cron を翻訳済みラベルにする', () => {
    expect(triggerLabel('manual', 'ja')).toBe('手動');
    expect(triggerLabel('cron', 'ja')).toBe('cron');
  });

  it('locale 省略時は既存呼び出し元互換のため en を返す', () => {
    expect(triggerLabel('manual')).toBe('manual');
    expect(triggerLabel('cron')).toBe('cron');
  });
});

describe('nextRunLabel', () => {
  const now = new Date('2026-07-05T00:00:00.000Z');

  it('cron 未設定は manual only', () => {
    expect(nextRunLabel(sampleWorkflow({ cron: null }), now)).toBe('manual only');
  });

  it('無効化中は Disabled', () => {
    expect(nextRunLabel(sampleWorkflow({ enabled: false }), now)).toBe('Disabled');
  });

  it('未来の予定は相対表示', () => {
    const workflow = sampleWorkflow({ nextRunAt: '2026-07-05T02:00:00.000Z' });
    expect(nextRunLabel(workflow, now)).toBe('in 2h');
  });

  it('到来済みは due now', () => {
    const workflow = sampleWorkflow({ nextRunAt: '2026-07-04T23:59:00.000Z' });
    expect(nextRunLabel(workflow, now)).toBe('due now');
  });
});

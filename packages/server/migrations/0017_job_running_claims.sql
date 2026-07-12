-- schedule と workflow は同一定義につき running run を1件だけ許可する。
-- 旧版が重複行を残していた場合は、id が最大の1件を残して他を aborted にする。

UPDATE schedule_runs
SET status = 'aborted', finished_at = COALESCE(finished_at, started_at)
WHERE status = 'running'
  AND id NOT IN (
    SELECT MAX(id) FROM schedule_runs WHERE status = 'running' GROUP BY schedule_id
  );

UPDATE workflow_step_runs
SET status = CASE WHEN status = 'running' THEN 'aborted' ELSE 'skipped' END,
    finished_at = COALESCE(finished_at, started_at)
WHERE status IN ('pending', 'running')
  AND run_id IN (
    SELECT id FROM workflow_runs
    WHERE status = 'running'
      AND id NOT IN (
        SELECT MAX(id) FROM workflow_runs WHERE status = 'running' GROUP BY workflow_id
      )
  );

UPDATE workflow_runs
SET status = 'aborted', finished_at = COALESCE(finished_at, started_at)
WHERE status = 'running'
  AND id NOT IN (
    SELECT MAX(id) FROM workflow_runs WHERE status = 'running' GROUP BY workflow_id
  );

CREATE UNIQUE INDEX idx_schedule_runs_one_running
  ON schedule_runs (schedule_id) WHERE status = 'running';

CREATE UNIQUE INDEX idx_workflow_runs_one_running
  ON workflow_runs (workflow_id) WHERE status = 'running';

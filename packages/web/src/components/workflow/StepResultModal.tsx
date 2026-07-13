/**
 * ワークフローステップの永続化済み結果を表示するモーダル。
 * 結果永続化 (RESULT_STORE) が有効な場合に保存された zstd JSONL の内容を
 * ページ単位で取得し、シンプルなテーブルとして描画する。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Table2 } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Spinner } from '../common/Spinner';
import { EmptyState } from '../common/EmptyState';
import { getWorkflowStepResult } from '../../api/workflows';
import { ApiClientError } from '../../api/client';

// 1 ページあたりの取得行数。
const PAGE_SIZE = 100;

/**
 * ステップ結果モーダルを描画する。
 * @param open モーダルの表示状態。
 * @param runId 対象の run id。
 * @param stepRunId 対象のステップ run id。
 * @param stepName ヘッダーに表示するステップ名。
 * @param onClose 閉じるコールバック。
 */
export function StepResultModal({
  open,
  runId,
  stepRunId,
  stepName,
  onClose,
}: {
  open: boolean;
  runId: string | null;
  stepRunId: string | null;
  stepName: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);

  const result = useQuery({
    queryKey: ['workflows', 'step-result', runId ?? '', stepRunId ?? '', page],
    queryFn: () => getWorkflowStepResult(runId!, stepRunId!, page * PAGE_SIZE, PAGE_SIZE),
    enabled: open && runId !== null && stepRunId !== null,
  });

  if (!open) return null;

  // 期限切れや永続化無効の 404 をユーザー向け文言に変換する。
  const notPersisted =
    result.error instanceof ApiClientError &&
    (result.error.status === 404 || result.error.detail.code === 'RESULT_NOT_PERSISTED');

  const data = result.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.totalRows / PAGE_SIZE)) : 1;

  return (
    <Modal
      open
      onClose={() => {
        setPage(0);
        onClose();
      }}
      title={`Result: ${stepName}`}
      description={data ? `${data.totalRows.toLocaleString()} rows persisted` : undefined}
      className="max-w-4xl"
      footer={
        data && data.totalRows > PAGE_SIZE ? (
          <>
            <span className="mr-auto font-mono text-2xs text-ink-subtle">
              page {page + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={ChevronLeft}
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={ChevronRight}
              iconAfter
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </>
        ) : undefined
      }
    >
      {result.isPending ? (
        <div className="flex items-center justify-center gap-2 py-10 font-mono text-2xs text-ink-subtle">
          <Spinner size={14} /> Loading result…
        </div>
      ) : result.isError ? (
        <EmptyState
          icon={Table2}
          title={notPersisted ? 'Result not available' : "Couldn't load the result"}
          description={
            notPersisted
              ? 'The result was not persisted or has expired.'
              : "The server didn't respond."
          }
          compact
        />
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-md border border-border-subtle">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-surface-sunken">
              <tr>
                {data!.columns.map((col) => (
                  <th
                    key={col.name}
                    className="border-b border-border-subtle px-2.5 py-1.5 font-mono text-2xs font-semibold whitespace-nowrap text-ink-muted"
                    title={col.type}
                  >
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data!.rows.map((row, i) => (
                <tr key={i} className="odd:bg-surface-base even:bg-surface-sunken/40">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="max-w-[24rem] truncate border-b border-border-subtle px-2.5 py-1 font-mono text-2xs text-ink-base"
                    >
                      {cell === null ? (
                        <span className="text-ink-subtle italic">NULL</span>
                      ) : (
                        String(cell)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {data!.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={Math.max(1, data!.columns.length)}
                    className="px-2.5 py-6 text-center font-mono text-2xs text-ink-subtle"
                  >
                    No rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

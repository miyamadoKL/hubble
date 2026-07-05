/**
 * Alert 機能向け TanStack Query hooks。
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  Alert,
  AlertEvalResponse,
  CreateAlertRequest,
  UpdateAlertRequest,
} from '@hubble/contracts';
import { listAlerts, createAlert, updateAlert, deleteAlert, evalAlertNow } from '../api/alerts';

const alertsKey = ['alerts', 'list'] as const;
const LIST_REFETCH_MS = 15_000;

/** Alert 一覧を取得する hook。 */
export function useAlerts(enabled = true): UseQueryResult<Alert[]> {
  return useQuery({
    queryKey: alertsKey,
    queryFn: listAlerts,
    enabled,
    refetchInterval: enabled ? LIST_REFETCH_MS : false,
    refetchOnMount: 'always',
  });
}

function useAlertInvalidation() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: alertsKey });
  };
}

export function useCreateAlert() {
  const invalidate = useAlertInvalidation();
  return useMutation({
    mutationFn: (body: CreateAlertRequest) => createAlert(body),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateAlert() {
  const invalidate = useAlertInvalidation();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAlertRequest }) => updateAlert(id, body),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAlert() {
  const invalidate = useAlertInvalidation();
  return useMutation({
    mutationFn: (id: string) => deleteAlert(id),
    onSuccess: () => invalidate(),
  });
}

export function useEvalAlertNow() {
  const invalidate = useAlertInvalidation();
  return useMutation({
    mutationFn: (id: string) => evalAlertNow(id),
    onSuccess: () => invalidate(),
  });
}

export type { Alert, AlertEvalResponse };

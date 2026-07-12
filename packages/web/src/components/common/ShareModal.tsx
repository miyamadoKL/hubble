/**
 * 保存済みクエリやノートブックの共有先を編集するモーダル。
 * fetch / update 関数を props で注入し、ドキュメント種別に依存しない。
 */
import { useEffect, useState } from 'react';
import type { DocumentShare, SharePermission, ShareSubjectType } from '@hubble/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Spinner } from './Spinner';
import { toast } from './Toast';
import { cn } from '../../utils/cn';
import { findDuplicateShareIndices, type ShareDraftRow } from '../../utils/documentShare';

const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

/** 空の共有行を 1 件生成する。 */
function emptyShareRow(): ShareDraftRow {
  return { subjectType: 'user', subjectValue: '', permission: 'view' };
}

/** サーバーから取得した共有エントリを編集用行に変換する。 */
function toDraftRows(shares: DocumentShare[]): ShareDraftRow[] {
  return shares.map(({ subjectType, subjectValue, permission }) => ({
    subjectType,
    subjectValue,
    permission,
  }));
}

/** 保存前に空行と空白 subjectValue を除外する。 */
function toSavePayload(rows: ShareDraftRow[]): ShareDraftRow[] {
  return rows
    .map((row) => ({ ...row, subjectValue: row.subjectValue.trim() }))
    .filter((row) => row.subjectValue.length > 0);
}

type FetchShares = () => Promise<{ shares: DocumentShare[] }>;

interface ShareLoadState {
  source: FetchShares;
  status: 'loading' | 'loaded' | 'error';
}

/**
 * 共有編集モーダル。
 *
 * @param open モーダルの表示状態。
 * @param onClose 閉じる操作時のコールバック。
 * @param documentName ヘッダー表示用のドキュメント名。
 * @param fetchShares 共有一覧を取得する関数（GET）。
 * @param updateShares 共有一覧を全置換する関数（PUT）。
 */
export function ShareModal({
  open,
  onClose,
  documentName,
  fetchShares,
  updateShares,
}: {
  open: boolean;
  onClose: () => void;
  documentName: string;
  fetchShares: () => Promise<{ shares: DocumentShare[] }>;
  updateShares: (shares: ShareDraftRow[]) => Promise<{ shares: DocumentShare[] }>;
}) {
  // open が false の間は描画しない。再オープン時に ShareModalBody が再マウントされる。
  if (!open) return null;
  return (
    <ShareModalBody
      onClose={onClose}
      documentName={documentName}
      fetchShares={fetchShares}
      updateShares={updateShares}
    />
  );
}

/**
 * 共有編集モーダルの本体。マウント時に共有一覧を取得する。
 */
function ShareModalBody({
  onClose,
  documentName,
  fetchShares,
  updateShares,
}: {
  onClose: () => void;
  documentName: string;
  fetchShares: () => Promise<{ shares: DocumentShare[] }>;
  updateShares: (shares: ShareDraftRow[]) => Promise<{ shares: DocumentShare[] }>;
}) {
  const [rows, setRows] = useState<ShareDraftRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<ShareLoadState>(() => ({
    source: fetchShares,
    status: 'loading',
  }));
  const activeLoadStatus = loadState.source === fetchShares ? loadState.status : 'loading';
  const loading = activeLoadStatus === 'loading';
  const loadError = activeLoadStatus === 'error';

  useEffect(() => {
    let cancelled = false;
    void fetchShares()
      .then((res) => {
        if (cancelled) return;
        setRows(res.shares.length > 0 ? toDraftRows(res.shares) : [emptyShareRow()]);
        setLoadState({ source: fetchShares, status: 'loaded' });
      })
      .catch(() => {
        if (cancelled) return;
        setLoadState({ source: fetchShares, status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchShares, loadAttempt]);

  const updateRow = (index: number, patch: Partial<ShareDraftRow>) => {
    setValidationError(null);
    setRows((cur) => cur.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    setValidationError(null);
    setRows((cur) => (cur.length <= 1 ? [emptyShareRow()] : cur.filter((_, i) => i !== index)));
  };

  const addRow = () => {
    setValidationError(null);
    setRows((cur) => [...cur, emptyShareRow()]);
  };

  const save = async () => {
    if (activeLoadStatus !== 'loaded') return;
    const payload = toSavePayload(rows);
    const dup = findDuplicateShareIndices(payload);
    if (dup) {
      setValidationError(`Duplicate share subject (rows ${dup[0] + 1} and ${dup[1] + 1}).`);
      return;
    }
    setValidationError(null);
    setSaving(true);
    try {
      await updateShares(payload);
      toast.success('Shares updated', `Sharing settings for “${documentName}” were saved.`);
      onClose();
    } catch {
      toast.error('Save failed', 'Could not update shares.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Share"
      description={`Manage who can access “${documentName}”.`}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={loading || saving || loadError}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 font-mono text-2xs text-ink-subtle">
          <Spinner size={14} /> Loading shares…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-start gap-3">
          <p className="w-full rounded-md border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">
            Could not load shares.
          </p>
          <Button
            variant="default"
            onClick={() => {
              setLoadState({ source: fetchShares, status: 'loading' });
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {validationError && (
            <p className="rounded-md border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">
              {validationError}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <li
                key={index}
                className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,7rem)_auto] items-end gap-2"
              >
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL}>Type</span>
                  <select
                    value={row.subjectType}
                    aria-label={`Share type row ${index + 1}`}
                    onChange={(e) =>
                      updateRow(index, { subjectType: e.target.value as ShareSubjectType })
                    }
                    className={cn(TEXT_INPUT, 'py-1.5')}
                  >
                    <option value="user">User</option>
                    <option value="group">Group</option>
                    <option value="role">Role</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL}>Subject</span>
                  <input
                    value={row.subjectValue}
                    aria-label={`Share subject row ${index + 1}`}
                    onChange={(e) => updateRow(index, { subjectValue: e.target.value })}
                    placeholder="user id, group, or role name"
                    className={TEXT_INPUT}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL}>Permission</span>
                  <select
                    value={row.permission}
                    aria-label={`Share permission row ${index + 1}`}
                    onChange={(e) =>
                      updateRow(index, { permission: e.target.value as SharePermission })
                    }
                    className={cn(TEXT_INPUT, 'py-1.5')}
                  >
                    <option value="view">Can view</option>
                    <option value="edit">Can edit</option>
                  </select>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  aria-label={`Remove share row ${index + 1}`}
                  onClick={() => removeRow(index)}
                  className="mb-0.5 text-ink-subtle hover:text-error"
                />
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" icon={Plus} onClick={addRow} className="self-start">
            Add share
          </Button>
        </div>
      )}
    </Modal>
  );
}

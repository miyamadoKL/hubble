/**
 * ドキュメントヘッダーに置く GitHub 同期コントロール。
 * 承認ステータスバッジ (approved / in review / modified / unlinked) を表示し、
 * クリックで GithubSyncModal を開く。連携機能が無効な環境では何も描画しない。
 */
import { useState } from 'react';
import type { DocumentGitType } from '@hubble/contracts';
import { useDocumentGitStatus, useGithubStatus } from '../../hooks/useGithub';
import { GitStatusBadge } from './GitStatusBadge';
import { GithubSyncModal } from './GithubSyncModal';
import { useT } from '../../i18n/t';
import { githubPanelMessages } from '../../i18n/messages/githubPanel';

/**
 * GitHub 同期コントロールを描画する。
 * @param type ドキュメント種別。
 * @param id ドキュメント id (未保存ドラフトなどは null で非表示)。
 * @param documentName モーダルに表示するドキュメント名。
 */
export function GitSyncControl({
  type,
  id,
  documentName,
}: {
  type: DocumentGitType;
  id: string | null;
  documentName: string;
}) {
  const t = useT(githubPanelMessages);
  const [open, setOpen] = useState(false);
  const global = useGithubStatus();
  const enabled = global.data?.enabled ?? false;
  const status = useDocumentGitStatus(type, id, enabled);

  // 連携無効、または対象が未保存 (id なし) のときは何も出さない。
  if (!enabled || id === null) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('syncButtonLabel')}
        title={t('syncButtonLabel')}
        className="rounded-full transition-opacity hover:opacity-80"
      >
        <GitStatusBadge status={status.data?.status ?? 'unlinked'} stale={status.data?.stale} />
      </button>
      <GithubSyncModal
        open={open}
        type={type}
        id={id}
        documentName={documentName}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

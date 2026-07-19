/**
 * ドキュメントの GitHub 同期モーダル。
 * 現在の承認ステータス、リポジトリ上のパス、PR リンクを表示し、
 * 「Push to GitHub」(コミットメッセージ付き) と「Create pull request」を
 * git 操作なしで実行できる。未接続時は接続ボタンを表示する。
 */
import { useState } from 'react';
import type { DocumentGitType } from '@hubble/contracts';
import {
  ExternalLink,
  GitBranch,
  GitFork,
  GitPullRequest,
  RotateCcw,
  UploadCloud,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Spinner } from '../common/Spinner';
import { toast } from '../common/Toast';
import { ApiClientError } from '../../api/client';
import { githubConnectUrl } from '../../api/github';
import { getNotebook } from '../../api/notebooks';
import { useNotebookStore } from '../../notebook';
import {
  useCreateDocumentPr,
  useDocumentGitStatus,
  useGithubStatus,
  usePullDocument,
  usePushDocument,
} from '../../hooks/useGithub';
import { GitStatusBadge } from './GitStatusBadge';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { githubPanelMessages } from '../../i18n/messages/githubPanel';

/** GithubSyncModal 内で使う辞書の合成。共通文言 + GitHub 同期固有文言を 1 つの t() で引けるようにする。 */
const githubSyncDict = { ...commonMessages, ...githubPanelMessages } as const;

const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

/**
 * GitHub 同期モーダルを描画する。
 * @param open モーダルの表示状態。
 * @param type ドキュメント種別。
 * @param id ドキュメント id。
 * @param documentName ヘッダーに表示するドキュメント名。
 * @param onClose 閉じるコールバック。
 */
export function GithubSyncModal({
  open,
  type,
  id,
  documentName,
  onClose,
}: {
  open: boolean;
  type: DocumentGitType;
  id: string;
  documentName: string;
  onClose: () => void;
}) {
  const t = useT(githubSyncDict);
  const global = useGithubStatus();
  const enabled = global.data?.enabled ?? false;
  const status = useDocumentGitStatus(type, open ? id : null, enabled);
  const push = usePushDocument(type, id);
  const createPr = useCreateDocumentPr(type, id);
  const pull = usePullDocument(type, id);
  const [message, setMessage] = useState('');
  // 「main へ戻す」の 2 段階確認 (誤操作でローカル編集を破棄しないため)。
  const [confirmPull, setConfirmPull] = useState(false);

  if (!open) return null;

  const connected = global.data?.connected ?? false;
  const doc = status.data;
  const busy = push.isPending || createPr.isPending || pull.isPending;

  // 閉じるときに 2 段階確認の状態をリセットする。
  const close = () => {
    setConfirmPull(false);
    onClose();
  };

  // API エラーをトーストに変換する共通ハンドラ。
  const onError = (title: string) => (err: unknown) => {
    const detail = err instanceof ApiClientError ? err.detail.message : t('couldNotReachServer');
    toast.error(title, detail);
  };

  const doPush = () => {
    push.mutate(message.trim() || undefined, {
      onSuccess: (res) => {
        toast.success(t('pushedToastTitle'), `${res.branch} @ ${res.commitSha.slice(0, 7)}`);
        setMessage('');
      },
      onError: onError(t('pushFailedToastTitle')),
    });
  };

  const doCreatePr = () => {
    createPr.mutate(undefined, {
      onSuccess: (res) => {
        toast.success(t('prReadyToastTitle'), `#${res.prNumber}`);
        window.open(res.prUrl, '_blank', 'noopener,noreferrer');
      },
      onError: onError(t('prFailedToastTitle')),
    });
  };

  // ローカル編集を破棄して main の承認済み内容へ戻す。ノートブックが開いている
  // 場合は取り込み後の内容をタブへ即時反映する (再オープン不要)。
  const doPull = () => {
    setConfirmPull(false);
    pull.mutate(undefined, {
      onSuccess: async (res) => {
        toast.success(
          t('revertedToastTitle'),
          t('revertedToastDescription', { commit: res.commit.slice(0, 7) }),
        );
        if (type === 'notebook') {
          try {
            const updated = await getNotebook(id);
            useNotebookStore.getState().replaceNotebook(updated);
          } catch {
            /* タブ未オープンや取得失敗は無視 (一覧側のキャッシュ無効化で反映される) */
          }
        }
      },
      onError: onError(t('revertFailedToastTitle')),
    });
  };

  return (
    <Modal
      open
      onClose={close}
      title={t('modalTitle')}
      description={t('modalDescription', { documentName })}
      footer={
        <>
          {/* main へ戻す (強制上書き)。リンク済みかつ承認内容が存在するときのみ。
              誤操作防止のため 2 段階確認にする。 */}
          {connected && doc && doc.status !== 'unlinked' && (
            <Button
              variant={confirmPull ? 'danger' : 'ghost'}
              icon={RotateCcw}
              onClick={() => (confirmPull ? doPull() : setConfirmPull(true))}
              disabled={busy}
              className="mr-auto"
              title={t('revertButtonTitle')}
            >
              {pull.isPending
                ? t('revertPending')
                : confirmPull
                  ? t('revertConfirm')
                  : t('revertButton')}
            </Button>
          )}
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('closeButton')}
          </Button>
          {connected && (
            <>
              <Button
                variant="default"
                icon={GitPullRequest}
                onClick={doCreatePr}
                disabled={busy || !doc?.branch}
                title={doc?.branch ? undefined : t('createPrDisabledTitle')}
              >
                {createPr.isPending ? t('createPrPending') : t('createPrButton')}
              </Button>
              <Button variant="primary" icon={UploadCloud} onClick={doPush} disabled={busy}>
                {push.isPending ? t('pushPending') : t('pushButton')}
              </Button>
            </>
          )}
        </>
      }
    >
      {status.isPending || global.isPending ? (
        <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
          <Spinner size={14} /> {t('checkingStatus')}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* 現在の承認ステータスとリポジトリ情報。 */}
          <div className="flex flex-wrap items-center gap-2">
            {doc && <GitStatusBadge status={doc.status} stale={doc.stale} />}
            {doc?.repo && (
              <span className="inline-flex items-center gap-1 font-mono text-2xs text-ink-subtle">
                <GitFork size={11} strokeWidth={2} />
                {doc.repo}
              </span>
            )}
            {doc?.path && <span className="font-mono text-2xs text-ink-subtle">{doc.path}</span>}
          </div>

          {/* ステータスの意味を短く説明し、次にとるべき操作を分かるようにする。 */}
          <p className="text-xs text-ink-muted">
            {doc?.status === 'approved' && t('statusDescriptionApproved')}
            {doc?.status === 'in_review' && t('statusDescriptionInReview')}
            {doc?.status === 'modified' && t('statusDescriptionModified')}
            {doc?.status === 'unlinked' && t('statusDescriptionUnlinked')}
          </p>

          {/* PR / ブランチへのリンク。 */}
          <div className="flex flex-wrap items-center gap-3">
            {doc?.prUrl && (
              <a
                href={doc.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                <GitPullRequest size={12} strokeWidth={2} />{' '}
                {t('prLinkPrefix', { prNumber: doc.prNumber ?? '' })}
                <ExternalLink size={11} strokeWidth={2} />
              </a>
            )}
            {doc?.branch && (
              <span className="inline-flex items-center gap-1 font-mono text-2xs text-ink-subtle">
                <GitBranch size={11} strokeWidth={2} /> {doc.branch}
              </span>
            )}
            {doc?.status === 'approved' && doc.htmlUrl && (
              <a
                href={doc.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                {t('viewOnGithub')} <ExternalLink size={11} strokeWidth={2} />
              </a>
            )}
          </div>

          {connected ? (
            /* コミットメッセージ入力 (任意)。 */
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-semibold tracking-wide text-ink-muted uppercase">
                {t('commitMessageLabel')}
              </span>
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t('commitMessagePlaceholder', {
                  path: doc?.path ?? t('commitMessagePlaceholderFallback'),
                })}
                className={cn(TEXT_INPUT, 'font-mono text-xs')}
              />
            </label>
          ) : (
            /* 未接続時は接続導線を出す。接続後はコールバックでアプリへ戻る。 */
            <div className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2.5">
              <p className="text-xs text-ink-muted">{t('connectPrompt')}</p>
              <Button
                variant="default"
                size="sm"
                icon={GitFork}
                className="mt-2"
                onClick={() => window.location.assign(githubConnectUrl())}
              >
                {t('connectGithubButton')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

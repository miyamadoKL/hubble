/**
 * GitHub 同期 UI（GitStatusBadge / GitSyncControl / GithubSyncModal）で使う文言の辞書。
 * ここに置くのは UI の地の文（ボタンラベル、見出し、説明文、トーストのタイトル等）
 * のみで、ブランチ名やコミット SHA、コミットメッセージ、ファイルパス、diff、
 * サーバーが返すステータス本文やエラー本文といった Git / サーバー由来の値は対象外
 * （そのまま表示する）。
 */
import { defineDictionary } from '../t';

export const githubPanelMessages = defineDictionary({
  // GitStatusBadge: 承認ステータスの固定ラベル。
  statusApproved: { ja: '承認済み', en: 'approved' },
  statusInReview: { ja: 'レビュー中', en: 'in review' },
  statusModified: { ja: '未反映変更あり', en: 'modified' },
  statusUnlinked: { ja: '未連携', en: 'unlinked' },
  staleStatusTitle: {
    ja: 'GitHub に接続できなかったため、キャッシュ済みのステータスを表示しています',
    en: 'GitHub could not be reached; showing cached status',
  },

  // GitSyncControl: バッジボタンの aria-label / title（可視テキストを持たないため
  // アクセシブルネームとして必須）。
  syncButtonLabel: { ja: 'GitHub 同期', en: 'GitHub sync' },

  // GithubSyncModal: タイトルと説明文。
  modalTitle: { ja: 'GitHub 同期', en: 'GitHub sync' },
  modalDescription: {
    ja: '「{documentName}」のバージョン管理とレビュー。',
    en: 'Version control and review for “{documentName}”.',
  },
  checkingStatus: { ja: 'ステータスを確認中…', en: 'Checking status…' },

  // ステータスの意味を説明する固定文言（サーバー本文ではなく UI 側の静的な説明）。
  statusDescriptionApproved: {
    ja: 'このドキュメントはデフォルトブランチ上の承認済みバージョンと一致しています。',
    en: 'This document matches the approved version on the default branch.',
  },
  statusDescriptionInReview: {
    ja: '最新の内容は push 済みでレビュー待ちです。プルリクエストをマージすると承認されます。',
    en: 'The latest content is pushed and waiting for review. Merge the pull request to approve it.',
  },
  statusDescriptionModified: {
    ja: 'ローカルの変更はまだ GitHub に反映されていません。push してプルリクエストを開き、レビューを受けてください。',
    en: 'Local changes are not on GitHub yet. Push and open a pull request to get them reviewed.',
  },
  statusDescriptionUnlinked: {
    ja: 'このドキュメントはまだ一度も push されていません。push してバージョン管理とレビューを開始してください。',
    en: 'This document has never been pushed. Push it to start version control and review.',
  },

  // PR / ブランチへのリンク。
  prLinkPrefix: { ja: 'PR #{prNumber}', en: 'PR #{prNumber}' },
  viewOnGithub: { ja: 'GitHub で表示', en: 'View on GitHub' },

  // コミットメッセージ入力欄。
  commitMessageLabel: { ja: 'コミットメッセージ（任意）', en: 'Commit message (optional)' },
  commitMessagePlaceholder: {
    ja: '{path} を Hubble 経由で更新',
    en: 'Update {path} via Hubble',
  },
  commitMessagePlaceholderFallback: { ja: 'ドキュメント', en: 'document' },

  // 未接続時の導線。
  connectPrompt: {
    ja: 'このドキュメントを push するには GitHub アカウントを連携してください。コミットはあなたの名前で作成されます。',
    en: 'Connect your GitHub account to push this document. Commits are authored as you.',
  },
  connectButton: { ja: 'GitHub と連携', en: 'Connect GitHub' },

  // フッターのボタン群。
  closeButton: { ja: '閉じる', en: 'Close' },
  createPrButton: { ja: 'プルリクエストを作成', en: 'Create pull request' },
  createPrPending: { ja: '作成中…', en: 'Creating…' },
  createPrDisabledTitle: {
    ja: '先にドキュメントを push してください',
    en: 'Push the document first',
  },
  pushButton: { ja: 'GitHub に push', en: 'Push to GitHub' },
  pushPending: { ja: 'push 中…', en: 'Pushing…' },
  revertButton: { ja: 'main に戻す', en: 'Revert to main' },
  revertPending: { ja: '取り消し中…', en: 'Reverting…' },
  revertConfirm: { ja: 'ローカルの変更を破棄しますか?', en: 'Discard local changes?' },
  revertButtonTitle: {
    ja: 'ローカルの変更を破棄し、デフォルトブランチの承認済みバージョンに戻します',
    en: 'Discard local changes and restore the approved version from the default branch',
  },

  // トースト（成功時タイトル。詳細本文は Git データそのものなので翻訳しない）。
  pushedToastTitle: { ja: 'GitHub に push しました', en: 'Pushed to GitHub' },
  prReadyToastTitle: { ja: 'プルリクエストを作成しました', en: 'Pull request ready' },
  revertedToastTitle: { ja: 'main に戻しました', en: 'Reverted to main' },
  revertedToastDescription: {
    ja: '{commit}（承認済み）に戻りました。',
    en: 'Now at {commit} (approved).',
  },

  // トースト（失敗時タイトル）。
  pushFailedToastTitle: { ja: 'push に失敗しました', en: 'Push failed' },
  prFailedToastTitle: { ja: 'プルリクエストの作成に失敗しました', en: 'Pull request failed' },
  revertFailedToastTitle: { ja: '取り消しに失敗しました', en: 'Revert failed' },
} as const);

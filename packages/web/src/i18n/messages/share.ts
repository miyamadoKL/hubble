/**
 * ドキュメント共有機能（ShareModal / DocumentShareBadge）で使う文言の辞書。
 */
import { defineDictionary } from '../t';

export const shareMessages = defineDictionary({
  shareTitle: { ja: '共有', en: 'Share' },
  shareDescription: {
    ja: '「{name}」へのアクセス権を管理します。',
    en: 'Manage who can access “{name}”.',
  },
  cancelButton: { ja: 'キャンセル', en: 'Cancel' },
  saveButton: { ja: '保存', en: 'Save' },
  savingButton: { ja: '保存中…', en: 'Saving…' },
  loadingShares: { ja: '共有設定を読み込み中…', en: 'Loading shares…' },
  loadSharesFailed: { ja: '共有設定を読み込めませんでした。', en: 'Could not load shares.' },
  retryButton: { ja: '再試行', en: 'Retry' },
  duplicateShareSubject: {
    ja: '共有先が重複しています（{a} 行目と {b} 行目）。',
    en: 'Duplicate share subject (rows {a} and {b}).',
  },
  sharesUpdatedTitle: { ja: '共有設定を更新しました', en: 'Shares updated' },
  sharesUpdatedBody: {
    ja: '「{name}」の共有設定を保存しました。',
    en: 'Sharing settings for “{name}” were saved.',
  },
  saveFailedTitle: { ja: '保存に失敗しました', en: 'Save failed' },
  saveSharesFailedBody: {
    ja: '共有設定を更新できませんでした。',
    en: 'Could not update shares.',
  },
  typeLabel: { ja: '種別', en: 'Type' },
  subjectLabel: { ja: '対象', en: 'Subject' },
  permissionLabel: { ja: '権限', en: 'Permission' },
  subjectTypeUser: { ja: 'ユーザー', en: 'User' },
  subjectTypeGroup: { ja: 'グループ', en: 'Group' },
  subjectTypeRole: { ja: 'ロール', en: 'Role' },
  // sharePermissionView / sharePermissionEdit は utils/documentShare.ts の
  // sharePermissionLabel（DocumentShareBadge の一覧表示でも共有）と同じ文言を持つ。
  sharePermissionView: { ja: '閲覧可', en: 'Can view' },
  sharePermissionEdit: { ja: '編集可', en: 'Can edit' },
  shareTypeRowAria: { ja: '共有種別（{n} 行目）', en: 'Share type row {n}' },
  shareSubjectRowAria: { ja: '共有対象（{n} 行目）', en: 'Share subject row {n}' },
  sharePermissionRowAria: { ja: '共有権限（{n} 行目）', en: 'Share permission row {n}' },
  removeShareRowAria: { ja: '共有行を削除（{n} 行目）', en: 'Remove share row {n}' },
  subjectPlaceholder: {
    ja: 'ユーザー ID、グループ名、ロール名',
    en: 'user id, group, or role name',
  },
  addShare: { ja: '共有を追加', en: 'Add share' },
  // DocumentShareBadge: 「{owner} が共有 ({permission})」の1行バッジ。
  sharedByLabel: { ja: '{owner} が共有（{permission}）', en: 'shared by {owner} ({permission})' },
} as const);

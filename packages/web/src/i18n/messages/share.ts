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
  loadingShares: { ja: '共有設定を読み込み中…', en: 'Loading shares…' },
  loadSharesFailed: { ja: '共有設定を読み込めませんでした。', en: 'Could not load shares.' },
  duplicateShareSubject: {
    ja: '共有先が重複しています（{a} 行目と {b} 行目）。',
    en: 'Duplicate share subject (rows {a} and {b}).',
  },
  sharesUpdatedTitle: { ja: '共有設定を更新しました', en: 'Shares updated' },
  sharesUpdatedBody: {
    ja: '「{name}」の共有設定を保存しました。',
    en: 'Sharing settings for “{name}” were saved.',
  },
  saveSharesFailedBody: {
    ja: '共有設定を更新できませんでした。',
    en: 'Could not update shares.',
  },
  subjectLabel: { ja: '対象', en: 'Subject' },
  permissionLabel: { ja: '権限', en: 'Permission' },
  subjectTypeUser: { ja: 'ユーザー', en: 'User' },
  // 共有主体の種別「グループ」。notebook.ts の chartGroupLabel（散布図の
  // グループ化列）とは概念が異なるため共通化しない
  // （レビュー指摘: 表記が同一でも翻訳文脈が別）。共有主体の「ロール」は
  // common.roleLabel（レイアウト側のロール概念と同一）を引き続き利用する。
  subjectTypeGroup: { ja: 'グループ', en: 'Group' },
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

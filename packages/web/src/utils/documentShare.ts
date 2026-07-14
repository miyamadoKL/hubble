/**
 * ドキュメント共有 UI で使う純粋関数群。
 * 所有者判定、共有バッジ用ラベル、共有先の重複検出を提供する。
 */
import type { MyPermission, SharePermission, ShareSubjectType } from '@hubble/contracts';

/** 共有一覧編集時の 1 行分（createdAt を除く PUT 用入力）。 */
export interface ShareDraftRow {
  subjectType: ShareSubjectType;
  subjectValue: string;
  permission: SharePermission;
}

/**
 * 呼び出し元がドキュメントの所有者かどうかを判定する。
 */
export function isDocumentOwner(myPermission?: MyPermission): boolean {
  return myPermission === 'owner';
}

/**
 * 他人から共有されたドキュメントかどうかを判定する。
 */
export function isSharedWithMe(myPermission?: MyPermission): boolean {
  return myPermission === 'view' || myPermission === 'edit';
}

/**
 * 共有 permission の UI 表示ラベルを返す。
 */
export function sharePermissionLabel(permission: SharePermission): string {
  return permission === 'edit' ? 'Can edit' : 'Can view';
}

/**
 * 共有先 (subjectType, subjectValue) の重複を検出する。
 * 最初に見つかった重複の 2 つの index を返す。重複がなければ null。
 */
export function findDuplicateShareIndices(rows: ShareDraftRow[]): [number, number] | null {
  const seen = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const value = row.subjectValue.trim();
    if (!value) continue;
    const key = `${row.subjectType}:${value}`;
    const prev = seen.get(key);
    if (prev !== undefined) return [prev, index];
    seen.set(key, index);
  }
  return null;
}

/**
 * ノートブックがサーバーへ PUT してよいかどうかを判定する。
 * draft は初回 POST 経路、view 共有は保存不可。
 */
export function canPersistNotebookToServer(opts: {
  draft: boolean;
  myPermission?: MyPermission;
}): boolean {
  if (opts.draft) return true;
  return opts.myPermission === 'owner' || opts.myPermission === 'edit';
}

/**
 * 編集画面を画面遷移調整器へ登録し、ブラウザー離脱時の未保存警告も有効にする hook。
 */
import { useEffect, useState } from 'react';
import {
  createDocumentNavigationOwner,
  hasDirtyActiveDocument,
  registerDocumentNavigation,
  updateDocumentNavigation,
  type DocumentNavigationOwner,
  type DocumentNavigationHandler,
} from '../navigation/documentNavigation';

/** 編集画面のマウント中に変わらないowner tokenを返す。 */
export function useDocumentNavigationOwner(): DocumentNavigationOwner {
  const [owner] = useState(createDocumentNavigationOwner);
  return owner;
}

/** Workflow または Dashboard の未保存状態と保存処理を登録する。 */
export function useDocumentNavigationGuard(
  { dirty, label, save }: DocumentNavigationHandler,
  owner: DocumentNavigationOwner,
): void {
  useEffect(() => registerDocumentNavigation(owner), [owner]);

  useEffect(
    () => updateDocumentNavigation(owner, { dirty, label, save }),
    [dirty, label, owner, save],
  );

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDirtyActiveDocument()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

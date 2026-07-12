/**
 * Workflow と Dashboard の編集画面が共有する画面遷移調整器。
 * 現在の編集画面が未保存かを確認し、画面遷移とグローバル保存を同じ登録情報へ集約する。
 */

/** 編集画面が画面遷移調整器へ登録する状態と保存処理。 */
export interface DocumentNavigationHandler {
  /** 確認ダイアログに表示する文書名。 */
  label: string;
  /** 現在の編集内容が未保存なら true。 */
  dirty: boolean;
  /** 現在の編集内容を保存する。 */
  save: () => void | Promise<void>;
}

interface ActiveDocumentNavigation {
  owner: DocumentNavigationOwner;
  handler: DocumentNavigationHandler | null;
  savePromise: Promise<void> | null;
}

let activeDocument: ActiveDocumentNavigation | null = null;
let bypassOwner: DocumentNavigationOwner | null = null;

/** 一つの編集画面インスタンスを識別するtoken。 */
export type DocumentNavigationOwner = symbol;

/** 編集画面インスタンスに対応する安定したowner tokenを生成する。 */
export function createDocumentNavigationOwner(): DocumentNavigationOwner {
  return Symbol('document-navigation');
}

/**
 * 現在表示中の編集画面ownerを登録する。
 * 戻り値は同じ登録だけを解除するため、再描画後の新しい登録を古い cleanup が消さない。
 */
export function registerDocumentNavigation(owner: DocumentNavigationOwner): () => void {
  const registration: ActiveDocumentNavigation = {
    owner,
    handler: null,
    savePromise: null,
  };
  activeDocument = registration;
  return () => {
    if (activeDocument === registration) activeDocument = null;
  };
}

/** 同じ編集画面ownerの最新dirty状態と保存処理を更新する。 */
export function updateDocumentNavigation(
  owner: DocumentNavigationOwner,
  handler: DocumentNavigationHandler,
): void {
  if (activeDocument?.owner === owner) activeDocument.handler = handler;
}

/**
 * 未保存の編集画面から離れる操作を確認してから実行する。
 * 利用者がキャンセルした場合は false を返し、渡された画面遷移を実行しない。
 */
export function requestDocumentNavigation(navigate: () => void): boolean {
  const document = activeDocument;
  if (document?.handler?.dirty && bypassOwner !== document.owner) {
    const confirmed =
      typeof window !== 'undefined' &&
      window.confirm(`“${document.handler.label}” has unsaved changes. Discard them?`);
    if (!confirmed) return false;
  }
  navigate();
  // Zustandのview更新直後からReactのeffect cleanupまでの間にも、旧画面の非同期完了を拒否する。
  if (activeDocument === document) activeDocument = null;
  return true;
}

/**
 * 保存または削除が成功した後の画面遷移を、破棄確認なしで実行する。
 * 開始元ownerが現在も表示中の場合だけ実行し、別画面へ移動済みの古い応答は無視する。
 */
export function continueDocumentNavigation(
  owner: DocumentNavigationOwner,
  navigate: () => void,
): boolean {
  if (activeDocument?.owner !== owner) return false;
  const previousBypassOwner = bypassOwner;
  bypassOwner = owner;
  try {
    return requestDocumentNavigation(navigate);
  } finally {
    bypassOwner = previousBypassOwner;
  }
}

/** 現在表示中の編集画面を保存し、編集画面がなければ false を返す。 */
export async function saveActiveDocument(): Promise<boolean> {
  const document = activeDocument;
  if (!document?.handler) return false;
  if (!document.savePromise) {
    const handler = document.handler;
    const task = Promise.resolve().then(() => handler.save());
    document.savePromise = task;
    const clear = () => {
      if (document.savePromise === task) document.savePromise = null;
    };
    void task.then(clear, clear);
  }
  await document.savePromise;
  return true;
}

/** ブラウザーを離れる前に未保存変更の確認が必要なら true を返す。 */
export function hasDirtyActiveDocument(): boolean {
  return activeDocument?.handler?.dirty ?? false;
}

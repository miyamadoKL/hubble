/**
 * 文書編集画面の保存委譲と未保存遷移確認を検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  continueDocumentNavigation,
  createDocumentNavigationOwner,
  hasDirtyActiveDocument,
  registerDocumentNavigation,
  requestDocumentNavigation,
  saveActiveDocument,
  updateDocumentNavigation,
  type DocumentNavigationOwner,
} from './documentNavigation';

let unregister: (() => void) | null = null;
let owner: DocumentNavigationOwner;

function register(handler: Parameters<typeof updateDocumentNavigation>[1]): void {
  owner = createDocumentNavigationOwner();
  unregister = registerDocumentNavigation(owner);
  updateDocumentNavigation(owner, handler);
}

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.restoreAllMocks();
});

describe('document navigation coordinator', () => {
  it('未保存変更の破棄を拒否した場合は画面遷移しない', () => {
    register({ label: 'Monthly report', dirty: true, save: vi.fn() });
    const navigate = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    expect(requestDocumentNavigation(navigate)).toBe(false);
    expect(confirm).toHaveBeenCalledWith('“Monthly report” has unsaved changes. Discard them?');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('破棄を確認した場合と保存済みの場合は画面遷移する', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    register({ label: 'Workflow', dirty: true, save: vi.fn() });
    const dirtyNavigate = vi.fn();

    expect(requestDocumentNavigation(dirtyNavigate)).toBe(true);
    expect(dirtyNavigate).toHaveBeenCalledOnce();

    unregister?.();
    register({ label: 'Dashboard', dirty: false, save: vi.fn() });
    const cleanNavigate = vi.fn();
    expect(requestDocumentNavigation(cleanNavigate)).toBe(true);
    expect(cleanNavigate).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('保存成功後の遷移では古い dirty 状態を確認しない', () => {
    register({ label: 'Workflow', dirty: true, save: vi.fn() });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const navigate = vi.fn();

    continueDocumentNavigation(owner, navigate);

    expect(navigate).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('グローバル保存を現在の編集画面へ委譲する', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    register({ label: 'Dashboard', dirty: true, save });

    await expect(saveActiveDocument()).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(hasDirtyActiveDocument()).toBe(true);

    unregister?.();
    unregister = null;
    await expect(saveActiveDocument()).resolves.toBe(false);
  });

  it('古い登録のcleanupが新しい編集画面を解除しない', async () => {
    const oldOwner = createDocumentNavigationOwner();
    const oldUnregister = registerDocumentNavigation(oldOwner);
    updateDocumentNavigation(oldOwner, {
      label: 'Old',
      dirty: true,
      save: vi.fn(),
    });
    const save = vi.fn();
    register({ label: 'New', dirty: true, save });

    oldUnregister();
    await saveActiveDocument();

    expect(save).toHaveBeenCalledOnce();
  });

  it('保存連打を一つのin-flight Promiseへ合流させる', async () => {
    let resolveSave!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    register({ label: 'New workflow', dirty: true, save });

    const first = saveActiveDocument();
    const second = saveActiveDocument();
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();

    resolveSave();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('古い画面ownerの非同期完了は現在画面を遷移させない', () => {
    register({ label: 'Old dashboard', dirty: true, save: vi.fn() });
    const oldOwner = owner;
    unregister?.();
    register({ label: 'Current dashboard', dirty: true, save: vi.fn() });
    const navigate = vi.fn();

    expect(continueDocumentNavigation(oldOwner, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('画面遷移直後はReact cleanup前でも開始元ownerを失効させる', () => {
    register({ label: 'Old dashboard', dirty: false, save: vi.fn() });
    const oldOwner = owner;

    expect(requestDocumentNavigation(vi.fn())).toBe(true);

    const staleNavigate = vi.fn();
    expect(continueDocumentNavigation(oldOwner, staleNavigate)).toBe(false);
    expect(staleNavigate).not.toHaveBeenCalled();
  });
});

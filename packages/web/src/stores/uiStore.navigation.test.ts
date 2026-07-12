/**
 * UI store の文書切替が未保存編集を破棄しないことを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  continueDocumentNavigation,
  createDocumentNavigationOwner,
  registerDocumentNavigation,
  updateDocumentNavigation,
  type DocumentNavigationOwner,
} from '../navigation/documentNavigation';
import { useUiStore } from './uiStore';

let unregister: (() => void) | null = null;
let owner: DocumentNavigationOwner;

function register(handler: Parameters<typeof updateDocumentNavigation>[1]): void {
  owner = createDocumentNavigationOwner();
  unregister = registerDocumentNavigation(owner);
  updateDocumentNavigation(owner, handler);
}

beforeEach(() => {
  useUiStore.setState({ workflowView: null, dashboardView: null });
});

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.restoreAllMocks();
  useUiStore.setState({ workflowView: null, dashboardView: null });
});

describe('uiStore document navigation', () => {
  it('未保存workflowからBackまたは別文書へ移る操作を拒否できる', () => {
    useUiStore.setState({ workflowView: { kind: 'workflow', id: 'workflow-a' } });
    register({ label: 'Workflow A', dirty: true, save: vi.fn() });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    useUiStore.getState().closeWorkflow();
    expect(useUiStore.getState().workflowView).toEqual({ kind: 'workflow', id: 'workflow-a' });

    useUiStore.getState().openDashboard('dashboard-b');
    expect(useUiStore.getState().workflowView).toEqual({ kind: 'workflow', id: 'workflow-a' });
    expect(useUiStore.getState().dashboardView).toBeNull();
  });

  it('破棄確認後は別文書へ切り替える', () => {
    useUiStore.setState({ dashboardView: { kind: 'dashboard', id: 'dashboard-a' } });
    register({ label: 'Dashboard A', dirty: true, save: vi.fn() });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    useUiStore.getState().openWorkflow('workflow-b');

    expect(useUiStore.getState().dashboardView).toBeNull();
    expect(useUiStore.getState().workflowView).toEqual({ kind: 'workflow', id: 'workflow-b' });
  });

  it('保存成功後の新規文書から保存済み文書への置換は確認しない', () => {
    useUiStore.setState({ dashboardView: { kind: 'new-dashboard' } });
    register({ label: 'New dashboard', dirty: true, save: vi.fn() });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    continueDocumentNavigation(owner, () => useUiStore.getState().openDashboard('saved-dashboard'));

    expect(useUiStore.getState().dashboardView).toEqual({
      kind: 'dashboard',
      id: 'saved-dashboard',
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('同じ文書を再選択しても破棄確認を出さない', () => {
    useUiStore.setState({ workflowView: { kind: 'workflow', id: 'workflow-a' } });
    register({ label: 'Workflow A', dirty: true, save: vi.fn() });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    useUiStore.getState().openWorkflow('workflow-a');

    expect(confirm).not.toHaveBeenCalled();
  });
});

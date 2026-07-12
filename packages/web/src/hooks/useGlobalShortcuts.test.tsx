/**
 * グローバル保存ショートカットが現在表示中の編集画面へ保存を委譲することを検証する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../notebook', () => ({
  saveActiveNotebook: vi.fn().mockResolvedValue({ noop: true }),
  runActiveSqlCell: vi.fn(),
}));
vi.mock('../editor/activeEditor', () => ({ getActiveEditor: vi.fn(() => null) }));
vi.mock('../editor/formatter', () => ({ formatEditor: vi.fn() }));

import { saveActiveNotebook } from '../notebook';
import {
  createDocumentNavigationOwner,
  registerDocumentNavigation,
  updateDocumentNavigation,
} from '../navigation/documentNavigation';
import { useGlobalShortcuts } from './useGlobalShortcuts';

function ShortcutHarness() {
  useGlobalShortcuts();
  return null;
}

let container: HTMLDivElement;
let root: Root;
let unregister: (() => void) | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ShortcutHarness />));
});

afterEach(() => {
  unregister?.();
  unregister = null;
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('useGlobalShortcuts save', () => {
  it('WorkflowまたはDashboardの保存を背後のnotebookより優先する', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const owner = createDocumentNavigationOwner();
    unregister = registerDocumentNavigation(owner);
    updateDocumentNavigation(owner, { label: 'Dashboard', dirty: true, save });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledOnce();
    expect(saveActiveNotebook).not.toHaveBeenCalled();
  });

  it('編集画面がない場合は従来どおりactive notebookを保存する', async () => {
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveActiveNotebook).toHaveBeenCalledOnce();
  });
});

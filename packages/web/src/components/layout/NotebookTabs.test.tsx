// notebookタブの未保存表示とブラウザー内永続化エラー表示を検証する。
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { NotebookTabs, type NotebookTab } from './NotebookTabs';

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

function renderTabs(tabs: NotebookTab[]): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  containers.push(container);
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NotebookTabs
        tabs={tabs}
        activeId={tabs[0]?.id ?? null}
        onSelect={() => undefined}
        onClose={() => undefined}
        onRename={() => undefined}
        onNew={() => undefined}
      />,
    );
  });
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

describe('NotebookTabs local persistence state', () => {
  test('ブラウザー内永続化失敗をdirty表示とは別の警告として示す', () => {
    const rendered = renderTabs([
      {
        id: 'nb-1',
        name: 'Notebook',
        dirty: true,
        conflict: false,
        localPersistenceError: true,
      },
    ]);

    expect(rendered.container.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    expect(
      rendered.container.querySelector('[aria-label="Browser recovery unavailable"]'),
    ).not.toBeNull();
    expect(rendered.container.querySelector('button[title]')?.getAttribute('title')).toContain(
      'browser recovery unavailable',
    );
    rendered.unmount();
  });

  test('永続化成功状態ではブラウザー内警告を表示しない', () => {
    const rendered = renderTabs([
      {
        id: 'nb-1',
        name: 'Notebook',
        dirty: true,
        conflict: false,
        localPersistenceError: false,
      },
    ]);

    expect(
      rendered.container.querySelector('[aria-label="Browser recovery unavailable"]'),
    ).toBeNull();
    rendered.unmount();
  });

  test('revision競合時はSave asによる保全導線を表示する', () => {
    const rendered = renderTabs([
      {
        id: 'nb-1',
        name: 'Notebook',
        dirty: true,
        conflict: true,
        localPersistenceError: false,
      },
    ]);

    const warning = rendered.container.querySelector('[aria-label="Notebook save conflict"]');
    expect(warning?.getAttribute('title')).toContain('Use Save as');
    expect(rendered.container.querySelector('button[title]')?.getAttribute('title')).toContain(
      'save conflict',
    );
    rendered.unmount();
  });
});

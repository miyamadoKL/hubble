// 共通UI primitiveのfocus、キーボード操作、live region semanticsを検証する。
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Dropdown } from './Dropdown';
import { Modal } from './Modal';
import { Tabs } from './Tabs';
import { toast, ToastViewport } from './Toast';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('共通UI primitiveのアクセシビリティ', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => toast.dismiss());
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  test('Modalは初期focus、focus trap、背景inert、focus復元を行う', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <main>
            <button type="button">Outside</button>
          </main>
          <Modal
            open={open}
            onClose={() => setOpen(false)}
            title="Accessible dialog"
            footer={<button type="button">Confirm</button>}
          >
            <input aria-label="Dialog input" />
          </Modal>
        </>
      );
    }
    act(() => root.render(<Harness />));
    const trigger = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open dialog',
    )!;
    trigger.focus();
    act(() => trigger.click());

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Confirm',
    )!;
    expect(document.activeElement).toBe(close);
    expect(container.querySelector('main')?.inert).toBe(true);

    confirm.focus();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(close);

    act(() => close.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('main')?.inert).not.toBe(true);
  });

  test('Modalが重なった状態で下位を先に閉じても背景inertを維持する', () => {
    const origin = document.createElement('button');
    document.body.appendChild(origin);
    origin.focus();
    let closeFirst!: () => void;
    let closeSecond!: () => void;
    function Harness() {
      const [first, setFirst] = useState(true);
      const [second, setSecond] = useState(true);
      closeFirst = () => setFirst(false);
      closeSecond = () => setSecond(false);
      return (
        <>
          <main>Outside</main>
          <ToastViewport />
          <Modal open={first} onClose={closeFirst} title="First dialog" />
          <Modal open={second} onClose={closeSecond} title="Second dialog" />
        </>
      );
    }
    act(() => root.render(<Harness />));
    const outside = container.querySelector('main')!;
    const overlays = [...container.querySelectorAll<HTMLElement>('[data-modal-overlay]')];
    const liveRegion = container.querySelector<HTMLElement>('[data-modal-live-region]')!;
    expect(outside.inert).toBe(true);
    expect(overlays[0]!.inert).toBe(true);
    expect(overlays[1]!.inert).not.toBe(true);
    expect(liveRegion.inert).not.toBe(true);
    expect(liveRegion.getAttribute('aria-hidden')).toBeNull();

    act(() => closeFirst());
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(outside.inert).toBe(true);
    expect(container.querySelector<HTMLElement>('[data-modal-overlay]')!.inert).not.toBe(true);

    act(() => closeSecond());
    expect(outside.inert).not.toBe(true);
    expect(document.activeElement).toBe(origin);
    origin.remove();
  });

  test('Dropdownはactive optionを公開しtrigger focusのまま選択する', () => {
    function Harness() {
      const [value, setValue] = useState('b');
      return (
        <Dropdown
          value={value}
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
            { value: 'c', label: 'Charlie' },
          ]}
          onChange={setValue}
          ariaLabel="Choose value"
        />
      );
    }
    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    trigger.focus();
    act(() => trigger.click());

    const initialActive = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(initialActive!)?.textContent).toContain('Beta');
    act(() =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    const nextActive = trigger.getAttribute('aria-activedescendant');
    const activeOption = document.getElementById(nextActive!);
    expect(activeOption?.textContent).toContain('Charlie');
    expect(activeOption?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(initialActive!)?.getAttribute('aria-selected')).toBe('false');

    act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(trigger.textContent).toContain('Charlie');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  test('Modal内DropdownのEscapeはlistboxだけを閉じる', () => {
    const onClose = vi.fn();
    act(() =>
      root.render(
        <Modal open onClose={onClose} title="Dialog with dropdown">
          <Dropdown
            value="a"
            options={[
              { value: 'a', label: 'Alpha' },
              { value: 'b', label: 'Beta' },
            ]}
            onChange={() => undefined}
            ariaLabel="Nested value"
          />
        </Modal>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('Tabsはroving tabindexと左右キーで無効タブを飛ばす', () => {
    function Harness() {
      const [value, setValue] = useState('a');
      return (
        <Tabs
          value={value}
          onChange={setValue}
          items={[
            { id: 'a', label: 'Alpha' },
            { id: 'b', label: 'Beta', disabled: true },
            { id: 'c', label: 'Charlie' },
          ]}
        />
      );
    }
    act(() => root.render(<Harness />));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    tabs[0]!.focus();
    act(() =>
      tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );

    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
  });

  test('successとinfo toastはpolite statusとして表示する', async () => {
    vi.useFakeTimers();
    act(() => root.render(<ToastViewport />));
    act(() => {
      toast.success('Saved');
      toast.info('Running', 'The query is still running.');
    });

    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[role="status"]')).toHaveLength(2),
    );
    const statuses = container.querySelectorAll<HTMLElement>('[role="status"]');
    expect(statuses).toHaveLength(2);
    for (const notification of statuses) {
      expect(notification.getAttribute('role')).toBe('status');
      expect(notification.getAttribute('aria-live')).toBe('polite');
      expect(notification.getAttribute('aria-atomic')).toBe('true');
    }
    expect(container.textContent).toContain('Saved');
    expect(container.textContent).toContain('The query is still running.');

    act(() => vi.advanceTimersByTime(3999));
    expect(container.querySelectorAll<HTMLElement>('[role="status"]')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(201));
    expect(container.querySelectorAll<HTMLElement>('[role="status"]')).toHaveLength(0);
  });

  test('error toastはassertive alertとして手動dismissまで保持する', async () => {
    vi.useFakeTimers();
    act(() => root.render(<ToastViewport />));
    act(() => {
      toast.error('Query failed', 'Retry after checking the connection.');
    });

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    const alert = container.querySelector('[role="alert"]');
    const notification = alert?.closest('li');
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.getAttribute('aria-atomic')).toBe('true');
    expect(notification?.querySelector('[aria-label="Dismiss notification"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

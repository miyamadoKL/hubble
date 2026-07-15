import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AlertStateBadge } from '../panels/AlertStateBadge';
import { ScheduleStatusBadge } from '../panels/ScheduleStatusBadge';
import { WorkflowStatusBadge } from '../workflow/WorkflowStatusBadge';
import { StateBadge } from './StateBadge';

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

describe('status badge wrappers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('各状態のラベルと色、実行中の点滅、ドット、追加クラスをDOMへ反映する', () => {
    act(() =>
      root.render(
        <>
          <StateBadge state="running" className="custom-badge" />
          <ScheduleStatusBadge status="success" />
          <ScheduleStatusBadge status="blocked" dot={false} />
          <WorkflowStatusBadge status="partial" />
          <AlertStateBadge state="triggered" />
        </>,
      ),
    );

    const badge = (label: string) =>
      [...container.querySelectorAll<HTMLElement>('span')].find(
        (element) => element.textContent === label && element.classList.contains('rounded-full'),
      )!;
    const running = badge('RUNNING');
    const success = badge('SUCCESS');
    const blocked = badge('BLOCKED');
    const partial = badge('partial');
    const triggered = badge('Triggered');

    expect(running.classList.contains('bg-running-soft')).toBe(true);
    expect(running.classList.contains('text-running')).toBe(true);
    expect(running.classList.contains('custom-badge')).toBe(true);
    expect(running.querySelector('.bg-running')?.classList.contains('animate-pulse')).toBe(true);
    expect(success.classList.contains('bg-success-soft')).toBe(true);
    expect(success.querySelector('.animate-pulse')).toBeNull();
    expect(blocked.classList.contains('bg-warning-soft')).toBe(true);
    expect(blocked.querySelector('span')).toBeNull();
    expect(partial.classList.contains('bg-warning-soft')).toBe(true);
    expect(partial.querySelector('.animate-pulse')).toBeNull();
    expect(triggered.classList.contains('bg-error-soft')).toBe(true);
    expect(triggered.querySelector('.animate-pulse')).toBeNull();
  });
});

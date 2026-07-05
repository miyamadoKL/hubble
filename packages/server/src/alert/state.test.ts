/**
 * Alert 状態遷移と閾値比較のユニットテスト。
 */
import { describe, expect, it } from 'vitest';
import { compareThreshold, nextAlertState, selectObservedValue, shouldNotify } from './state';

describe('alert state', () => {
  it('compares numeric thresholds', () => {
    expect(compareThreshold({ observed: 10, op: '>', threshold: '5' })).toBe(true);
    expect(compareThreshold({ observed: 3, op: '>=', threshold: '3' })).toBe(true);
    expect(compareThreshold({ observed: 1, op: '<', threshold: '2' })).toBe(true);
  });

  it('compares string thresholds with == and != only', () => {
    expect(compareThreshold({ observed: 'ok', op: '==', threshold: 'ok' })).toBe(true);
    expect(compareThreshold({ observed: 'fail', op: '!=', threshold: 'ok' })).toBe(true);
    expect(compareThreshold({ observed: 'a', op: '>', threshold: 'b' })).toBe(false);
  });

  it('selects first, max, and min', () => {
    const rows = [[1], [3], [2]];
    expect(selectObservedValue(rows, 0, 'first')).toBe(1);
    expect(selectObservedValue(rows, 0, 'max')).toBe(3);
    expect(selectObservedValue(rows, 0, 'min')).toBe(1);
  });

  it('computes next state from condition', () => {
    expect(nextAlertState('unknown', true)).toBe('triggered');
    expect(nextAlertState('unknown', false)).toBe('ok');
    expect(nextAlertState('ok', true)).toBe('triggered');
    expect(nextAlertState('triggered', false)).toBe('ok');
  });

  it('does not notify on unknown to ok', () => {
    expect(
      shouldNotify({
        previousState: 'unknown',
        newState: 'ok',
        rearm: 0,
        lastTriggeredAt: null,
        nowMs: 0,
        muted: false,
      }),
    ).toBe(false);
  });

  it('notifies on transition to triggered with rearm 0', () => {
    expect(
      shouldNotify({
        previousState: 'ok',
        newState: 'triggered',
        rearm: 0,
        lastTriggeredAt: null,
        nowMs: 0,
        muted: false,
      }),
    ).toBe(true);
  });

  it('does not re-notify while triggered with rearm 0', () => {
    expect(
      shouldNotify({
        previousState: 'triggered',
        newState: 'triggered',
        rearm: 0,
        lastTriggeredAt: '2026-01-01T00:00:00.000Z',
        nowMs: Date.parse('2026-01-01T01:00:00.000Z'),
        muted: false,
      }),
    ).toBe(false);
  });

  it('re-notifies every evaluation with rearm 1', () => {
    expect(
      shouldNotify({
        previousState: 'triggered',
        newState: 'triggered',
        rearm: 1,
        lastTriggeredAt: '2026-01-01T00:00:00.000Z',
        nowMs: Date.parse('2026-01-01T00:00:01.000Z'),
        muted: false,
      }),
    ).toBe(true);
  });

  it('respects rearm seconds', () => {
    const last = '2026-01-01T00:00:00.000Z';
    expect(
      shouldNotify({
        previousState: 'triggered',
        newState: 'triggered',
        rearm: 300,
        lastTriggeredAt: last,
        nowMs: Date.parse('2026-01-01T00:04:00.000Z'),
        muted: false,
      }),
    ).toBe(false);
    expect(
      shouldNotify({
        previousState: 'triggered',
        newState: 'triggered',
        rearm: 300,
        lastTriggeredAt: last,
        nowMs: Date.parse('2026-01-01T00:05:00.000Z'),
        muted: false,
      }),
    ).toBe(true);
  });

  it('never notifies when muted', () => {
    expect(
      shouldNotify({
        previousState: 'ok',
        newState: 'triggered',
        rearm: 0,
        lastTriggeredAt: null,
        nowMs: 0,
        muted: true,
      }),
    ).toBe(false);
  });
});

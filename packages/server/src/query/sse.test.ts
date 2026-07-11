// queryイベントのSSEエンコード、合成終端とリプレイ送信境界を検証する。
import { describe, expect, it, vi } from 'vitest';
import type { QueryEvent } from '@hubble/contracts';
import {
  encodeSseEvent,
  flushPendingSseEvents,
  throughForcedTerminal,
  type EncodedSseEvent,
} from './sse';

describe('encodeSseEvent', () => {
  it('契約に沿う制御イベントを送信形式へ変換する', () => {
    expect(
      encodeSseEvent({ type: 'done', state: 'finished', rowCount: 1, truncated: false }),
    ).toMatchObject({ frame: expect.stringContaining('event: done'), forcedTerminal: false });
  });

  it('契約に反する制御イベントを記録して送信しない', () => {
    const invalid = {
      type: 'done',
      state: 'finished',
      rowCount: -1,
      truncated: false,
    } as QueryEvent;

    const logError = vi.fn();
    expect(encodeSseEvent(invalid, logError)).toMatchObject({
      frame: expect.stringContaining('event: error'),
      forcedTerminal: true,
    });
    expect(logError).toHaveBeenCalledOnce();
  });

  it('高頻度のrowsイベントは送信境界で再検証しない', () => {
    const rows = { type: 'rows', offset: 0, rows: [[1]] } as QueryEvent;
    expect(encodeSseEvent(rows)).toMatchObject({ frame: expect.stringContaining('event: rows') });
  });

  it('不正doneを検証済みerrorとdoneへ置き換える', () => {
    const invalid = { type: 'done', state: 'running', rowCount: -1 } as QueryEvent;
    const encoded = encodeSseEvent(invalid, () => {});
    expect(encoded?.forcedTerminal).toBe(true);
    expect(encoded?.frame).toContain('"code":"INTERNAL_ERROR"');
    expect(encoded?.frame).toContain('"state":"failed"');
  });

  it('replay中の合成終端を送信し、それより後のframeだけを捨てる', () => {
    const events: EncodedSseEvent[] = [
      { frame: 'event: rows\n\n', forcedTerminal: false },
      { frame: 'event: error\nevent: done\n\n', forcedTerminal: true },
      { frame: 'event: rows-after-done\n\n', forcedTerminal: false },
    ];

    expect(throughForcedTerminal(events).map((event) => event.frame)).toEqual([
      'event: rows\n\n',
      'event: error\nevent: done\n\n',
    ]);
  });

  it('pending flush中に終端が割り込んだら残りのframeを送らない', async () => {
    const events: EncodedSseEvent[] = [
      { frame: 'rows-1', forcedTerminal: false },
      { frame: 'rows-2', forcedTerminal: false },
    ];
    const written: string[] = [];
    let terminated = false;

    await flushPendingSseEvents(
      events,
      false,
      () => terminated,
      async (frame) => {
        written.push(frame);
        terminated = true;
      },
    );

    expect(written).toEqual(['rows-1']);
  });

  it('flush開始直前にlive終端が届いていたらpendingを送らない', async () => {
    const events: EncodedSseEvent[] = [{ frame: 'rows-after-done', forcedTerminal: false }];
    const write = vi.fn(async () => undefined);

    await flushPendingSseEvents(events, false, () => true, write);

    expect(write).not.toHaveBeenCalled();
  });
});

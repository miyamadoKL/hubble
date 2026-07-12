// queryイベントのSSEエンコード、合成終端とリプレイ送信境界を検証する。
import { describe, expect, it, vi } from 'vitest';
import type { QueryEvent } from '@hubble/contracts';
import {
  DEFAULT_SSE_BACKLOG_BYTES,
  encodeSseEvent,
  flushPendingSseEvents,
  SerializedSseWriter,
  SseBacklogOverflowError,
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

  it('queue済みだが未送信の終端で先行batchのrowsを捨てない', async () => {
    const firstBatch: EncodedSseEvent[] = [
      { frame: 'rows-1', forcedTerminal: false },
      { frame: 'rows-2', forcedTerminal: false },
    ];
    const terminalBatch: EncodedSseEvent[] = [{ frame: 'error-and-done', forcedTerminal: true }];
    const written: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let terminalWritten = false;
    const write = async (frame: string): Promise<void> => {
      written.push(frame);
      if (frame === 'rows-1') {
        firstStarted();
        await firstBlocked;
      }
    };

    const flushingFirst = flushPendingSseEvents(firstBatch, false, () => terminalWritten, write);
    await firstStartedPromise;
    // 終端が次 batch へ queue されても、未送信の間は terminalWritten を立てない。
    releaseFirst();
    await flushingFirst;
    expect(written).toEqual(['rows-1', 'rows-2']);

    await flushPendingSseEvents(terminalBatch, true, () => terminalWritten, write);
    terminalWritten = true;
    expect(written).toEqual(['rows-1', 'rows-2', 'error-and-done']);
  });
});

describe('SerializedSseWriter', () => {
  it('同じ接続の write を一列に直列化する', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: string[] = [];
    const writer = new SerializedSseWriter(async (frame) => {
      writes.push(frame);
      if (frame === 'first') await first;
    });

    expect(writer.enqueue('first')).toBe(true);
    expect(writer.enqueue('second')).toBe(true);
    await vi.waitFor(() => expect(writes).toEqual(['first']));

    releaseFirst();
    await writer.drain();
    expect(writes).toEqual(['first', 'second']);
  });

  it('write rejection を通知して後続 frame を送らない', async () => {
    const failure = new Error('connection closed');
    const onFailure = vi.fn();
    const write = vi.fn().mockRejectedValue(failure);
    const writer = new SerializedSseWriter(write, { onFailure });

    expect(writer.enqueue('first')).toBe(true);
    await writer.drain();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(failure);
    expect(writer.enqueue('second')).toBe(false);
    expect(write).toHaveBeenCalledOnce();
  });

  it('未送信 byte 上限を超えた接続を失敗させる', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onFailure = vi.fn();
    const writer = new SerializedSseWriter(() => blocked, {
      maxBacklogBytes: 8,
      onFailure,
    });

    expect(writer.enqueue('12345678')).toBe(true);
    expect(writer.enqueue('x')).toBe(false);
    expect(onFailure).toHaveBeenCalledWith(expect.any(SseBacklogOverflowError));
    expect(writer.enqueue('y')).toBe(false);

    release();
    await writer.drain();
  });

  it('既定 backlog 上限を有限値にする', () => {
    expect(DEFAULT_SSE_BACKLOG_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_SSE_BACKLOG_BYTES)).toBe(true);
  });
});

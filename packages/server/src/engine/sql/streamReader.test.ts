/**
 * RowStreamReader の背圧制御テスト。
 */
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { QUEUE_HIGH_WATER_MULTIPLIER, RowStreamReader } from './streamReader';

interface ControllableStream {
  stream: Readable;
  actions: string[];
  /** キューに載せる行を追加する(ストリームが pause 中なら保留)。 */
  enqueueRows: (rows: unknown[][]) => void;
}

/**
 * pause/resume を記録し、背圧を尊重するフェイク Readable を作る。
 */
function makeControllableStream(): ControllableStream {
  const actions: string[] = [];
  const pending: unknown[][] = [];
  let flowing = false;

  const stream = new Readable({
    objectMode: true,
    read() {
      flowing = true;
      drainPending();
    },
  });

  const drainPending = (): void => {
    if (!flowing) return;
    while (pending.length > 0 && flowing) {
      const row = pending.shift()!;
      const ok = stream.push(row);
      if (!ok) {
        flowing = false;
        return;
      }
    }
  };

  const origPause = stream.pause.bind(stream);
  stream.pause = () => {
    actions.push('pause');
    flowing = false;
    return origPause();
  };

  const origResume = stream.resume.bind(stream);
  stream.resume = () => {
    actions.push('resume');
    const result = origResume();
    flowing = true;
    drainPending();
    return result;
  };

  return {
    stream,
    actions,
    enqueueRows(rows: unknown[][]) {
      pending.push(...rows);
      drainPending();
    },
  };
}

describe('RowStreamReader', () => {
  it('reads rows in fixed-size batches until done', async () => {
    const { stream, enqueueRows } = makeControllableStream();
    const reader = new RowStreamReader(stream, { batchSize: 3 });
    enqueueRows([[1], [2], [3], [4], [5]]);
    stream.push(null);

    const first = await reader.readBatch(3);
    expect(first.rows).toEqual([[1], [2], [3]]);
    expect(first.done).toBe(false);

    const second = await reader.readBatch(3);
    expect(second.rows).toEqual([[4], [5]]);
    expect(second.done).toBe(true);
  });

  it('pauses the stream when queue exceeds the high water mark', async () => {
    const batchSize = 10;
    const highWaterMark = batchSize * QUEUE_HIGH_WATER_MULTIPLIER;
    const { stream, actions, enqueueRows } = makeControllableStream();
    const reader = new RowStreamReader(stream, { batchSize });

    enqueueRows(Array.from({ length: highWaterMark }, (_, i) => [i]));

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reader.queueDepth()).toBe(highWaterMark);
    expect(actions).toContain('pause');
    expect(reader.isPaused()).toBe(true);

    const first = await reader.readBatch(batchSize);
    expect(first.rows).toHaveLength(batchSize);
    expect(reader.queueDepth()).toBe(batchSize);
    expect(actions).toContain('resume');
    expect(reader.isPaused()).toBe(false);
  });

  it('keeps queue depth under the high water mark with a slow consumer', async () => {
    const batchSize = 5;
    const highWaterMark = batchSize * QUEUE_HIGH_WATER_MULTIPLIER;
    const totalRows = highWaterMark * 3;
    const { stream, actions, enqueueRows } = makeControllableStream();
    const reader = new RowStreamReader(stream, { batchSize });

    let maxDepth = 0;
    enqueueRows(Array.from({ length: totalRows }, (_, i) => [i]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    maxDepth = Math.max(maxDepth, reader.queueDepth());

    const collected: unknown[][] = [];
    while (collected.length < totalRows) {
      const { rows } = await reader.readBatch(batchSize);
      collected.push(...rows);
      maxDepth = Math.max(maxDepth, reader.queueDepth());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    stream.push(null);

    expect(maxDepth).toBeLessThanOrEqual(highWaterMark);
    expect(actions).toContain('pause');
    expect(actions.filter((a) => a === 'resume').length).toBeGreaterThan(0);
    expect(collected).toHaveLength(totalRows);
  });

  it('resolves readBatch waiting on empty queue when dispose is called', async () => {
    const stream = new Readable({ objectMode: true, read() {} });
    const reader = new RowStreamReader(stream, { batchSize: 2 });
    const pending = reader.readBatch(2);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    reader.dispose();
    await expect(pending).resolves.toEqual({ rows: [], done: true });
  });

  it('dispose resumes a paused stream and unblocks waiters', async () => {
    const batchSize = 2;
    const { stream, actions, enqueueRows } = makeControllableStream();
    const reader = new RowStreamReader(stream, { batchSize });

    enqueueRows([[1], [2], [3], [4]]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reader.isPaused()).toBe(true);

    const pending = reader.readBatch(batchSize);
    reader.dispose();

    await expect(pending).resolves.toEqual({
      rows: [[1], [2]],
      done: false,
    });
    expect(actions).toContain('resume');
  });
});

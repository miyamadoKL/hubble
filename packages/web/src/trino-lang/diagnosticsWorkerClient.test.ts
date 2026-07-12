/** SQL 診断 Worker の応答変換とキャンセルを検証する。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDiagnostics } from './diagnosticsWorkerClient';

class FakeWorker {
  static latest: FakeWorker | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: unknown;

  constructor() {
    FakeWorker.latest = this;
  }

  postMessage(value: unknown) {
    this.posted = value;
  }

  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.latest = undefined;
});

describe('startDiagnostics', () => {
  it('runs parsing through a Worker and restores TableReference values', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const task = startDiagnostics({ sql: 'SELECT * FROM orders', catalog: 'c', schema: 's' });
    expect(FakeWorker.latest?.posted).toEqual({
      sql: 'SELECT * FROM orders',
      catalog: 'c',
      schema: 's',
    });
    FakeWorker.latest?.onmessage?.({
      data: {
        markers: [],
        descriptors: [],
        tableReferences: [{ catalogName: 'c', schemaName: 's', tableName: 'orders' }],
      },
    } as MessageEvent);
    const result = await task.promise;
    expect(result.tableReferences[0]?.fullyQualified).toBe('c.s.orders');
    expect(FakeWorker.latest?.terminated).toBe(true);
  });

  it('terminates an obsolete generation and rejects it as aborted', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const task = startDiagnostics({ sql: 'SELECT 1' });
    task.cancel();
    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.latest?.terminated).toBe(true);
  });
});

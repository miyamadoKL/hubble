import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db';
import type { HistoryRepository } from '../store/history';
import { HistoryRepository as HistoryRepositoryImpl } from '../store/history';
import { ResultObjectDeletionRepository } from '../store/resultObjectDeletions';
import { ResultParquetConversionJobRepository } from '../store/resultParquetConversionJobs';
import { ParquetConverterError } from './parquetConverter';
import { ParquetConversionWorker } from './parquetConversionWorker';
import type {
  DeleteExpiredResult,
  ExpiredResultObject,
  ResultArtifactFormat,
  ResultStore,
  ResultStoreRequestOptions,
} from './store';

class WorkerResultStore implements ResultStore {
  readonly enabled = true;
  readonly objects = new Map<string, Buffer>();
  failPut = false;
  readonly deleted: string[] = [];

  async put(key: string, body: Readable, _format: ResultArtifactFormat): Promise<void> {
    void _format;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    this.objects.set(key, Buffer.concat(chunks));
    if (this.failPut) throw new Error('partial upload');
  }

  async getStream(key: string): Promise<Readable> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`missing object: ${key}`);
    return Readable.from(body);
  }

  async stat(key: string, _options?: ResultStoreRequestOptions) {
    void _options;
    const body = this.objects.get(key);
    if (!body) throw new Error(`missing object: ${key}`);
    return { size: body.length };
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
    _options?: ResultStoreRequestOptions,
  ): Promise<Buffer> {
    void _options;
    const body = this.objects.get(key);
    if (!body) throw new Error(`missing object: ${key}`);
    return body.subarray(offset, offset + length);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }

  async deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult> {
    for (const object of objects) await this.delete(object.key);
    return { deleted: objects.map((object) => object.key), failed: [] };
  }

  async close(): Promise<void> {}
}

const NOW = '2026-07-13T00:00:00.000Z';
const EXPIRES = '2026-07-14T00:00:00.000Z';

interface WorkerFixture {
  db: Awaited<ReturnType<typeof openMemoryDatabase>>;
  history: HistoryRepository;
  jobs: ResultParquetConversionJobRepository;
  deletions: ResultObjectDeletionRepository;
  store: WorkerResultStore;
}

async function fixture(options: { columns?: boolean } = {}): Promise<WorkerFixture> {
  const db = await openMemoryDatabase();
  const history = new HistoryRepositoryImpl(db);
  const jobs = new ResultParquetConversionJobRepository(db);
  const deletions = new ResultObjectDeletionRepository(db);
  const store = new WorkerResultStore();
  await history.insert({
    id: 'history-1',
    statement: 'SELECT 1',
    state: 'running',
    owner: 'alice',
    datasourceId: 'trino-default',
    submittedAt: NOW,
  });
  await history.setResultObject(
    'history-1',
    'hubble-results/history-1.jsonl.zst',
    EXPIRES,
    { state: 'finished', rowCount: 1, elapsedMs: 1 },
    options.columns === false ? [] : [{ name: 'id', type: 'bigint' }],
    'jsonl.zst',
  );
  await db.run('UPDATE query_history SET result_columns_json=NULL WHERE id=?', ['history-1']);
  if (options.columns !== false) {
    await history.setResultObject(
      'history-1',
      'hubble-results/history-1.jsonl.zst',
      EXPIRES,
      { state: 'finished', rowCount: 1, elapsedMs: 1 },
      [{ name: 'id', type: 'bigint' }],
      'jsonl.zst',
    );
  }
  store.objects.set('hubble-results/history-1.jsonl.zst', Buffer.from('jsonl'));
  await jobs.enqueue(
    {
      historyId: 'history-1',
      sourceObjectKey: 'hubble-results/history-1.jsonl.zst',
      targetObjectKey: 'hubble-results/history-1.parquet',
      encodingVersion: '1',
    },
    NOW,
  );
  return { db, history, jobs, deletions, store };
}

describe('ParquetConversionWorker', () => {
  it('replays a pending job after restart and links the persisted target', async () => {
    const state = await fixture();
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      now: () => Date.parse(NOW),
      converter: async (input) => {
        await writeFile(input.outputPath, 'parquet');
        return { outputPath: input.outputPath, rowCount: input.expectedRowCount };
      },
    });

    await worker.tick();

    expect(await state.history.getResultRef('alice', 'history-1')).toMatchObject({
      parquetRef: {
        objectKey: 'hubble-results/history-1.parquet',
        expiresAt: EXPIRES,
        encodingVersion: '1',
      },
    });
    expect(await state.jobs.get('history-1')).toBeUndefined();
    expect(state.store.objects.get('hubble-results/history-1.parquet')?.toString()).toBe('parquet');
    await state.db.close();
  });

  it('moves a missing metadata job to dead without invoking the converter', async () => {
    const state = await fixture({ columns: false });
    let converted = false;
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      now: () => Date.parse(NOW),
      converter: async () => {
        converted = true;
        throw new Error('unexpected conversion');
      },
    });

    await worker.tick();

    expect(converted).toBe(false);
    expect(await state.jobs.get('history-1')).toMatchObject({
      status: 'dead',
      lastErrorCode: 'missing_columns',
      attempts: 0,
    });
    await state.db.close();
  });

  it('marks an expired source obsolete before opening the source stream', async () => {
    const state = await fixture();
    await state.db.run('UPDATE query_history SET result_expires_at=? WHERE id=?', [
      '2026-07-12T00:00:00.000Z',
      'history-1',
    ]);
    let opened = false;
    const originalGetStream = state.store.getStream.bind(state.store);
    state.store.getStream = async (key) => {
      opened = true;
      return originalGetStream(key);
    };
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      now: () => Date.parse(NOW),
    });

    await worker.tick();

    expect(opened).toBe(false);
    expect(await state.jobs.get('history-1')).toBeUndefined();
    await state.db.close();
  });

  it('completes without converting when the target is already linked', async () => {
    const state = await fixture();
    await state.history.setParquetObject(
      'history-1',
      'hubble-results/history-1.jsonl.zst',
      'hubble-results/history-1.parquet',
      '1',
    );
    let converted = false;
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      now: () => Date.parse(NOW),
      converter: async () => {
        converted = true;
        throw new Error('unexpected conversion');
      },
    });

    await worker.tick();

    expect(converted).toBe(false);
    expect(await state.jobs.get('history-1')).toBeUndefined();
    await state.db.close();
  });

  it('cleans a partial target upload and retries with exponential attempt accounting', async () => {
    const state = await fixture();
    state.store.failPut = true;
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      config: { backoffMs: 0, maxAttempts: 2 },
      now: () => Date.parse(NOW),
      converter: async (input) => {
        await writeFile(input.outputPath, 'parquet');
        return { outputPath: input.outputPath, rowCount: input.expectedRowCount };
      },
    });

    await worker.tick();
    expect(state.store.deleted).toContain('hubble-results/history-1.parquet');
    expect(await state.jobs.get('history-1')).toMatchObject({ status: 'pending', attempts: 1 });

    state.store.failPut = false;
    await worker.tick();
    expect(await state.jobs.get('history-1')).toBeUndefined();
    await state.db.close();
  });

  it('cleans a stale target left by a previous process when conversion fails early', async () => {
    const state = await fixture();
    state.store.objects.set('hubble-results/history-1.parquet', Buffer.from('stale'));
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      config: { backoffMs: 0, maxAttempts: 2 },
      now: () => Date.parse(NOW),
      converter: async () => {
        throw new ParquetConverterError('duckdb_error', 'conversion failed', {
          permanent: false,
        });
      },
    });

    await worker.tick();

    expect(state.store.deleted).toContain('hubble-results/history-1.parquet');
    expect((await state.jobs.get('history-1'))?.attempts).toBe(1);
    await state.db.close();
  });

  it('does not consume an attempt when shutdown aborts conversion', async () => {
    const state = await fixture();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      now: () => Date.parse(NOW),
      converter: async (input) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(new ParquetConverterError('aborted', 'shutdown')),
            { once: true },
          );
        });
        throw new Error('unreachable');
      },
    });

    const running = worker.tick();
    await startedPromise;
    await worker.stop();
    await running;

    expect(await state.jobs.get('history-1')).toMatchObject({ status: 'pending', attempts: 0 });
    await state.db.close();
  });

  it('does not consume an attempt for converter timeout', async () => {
    const state = await fixture();
    const worker = new ParquetConversionWorker({
      jobs: state.jobs,
      history: state.history,
      resultStore: state.store,
      resultObjectDeletions: state.deletions,
      config: { backoffMs: 0, maxAttempts: 2 },
      now: () => Date.parse(NOW),
      converter: async () => {
        throw new ParquetConverterError('timed_out', 'conversion timed out');
      },
    });

    await worker.tick();

    expect(await state.jobs.get('history-1')).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'timed_out',
    });
    await worker.tick();
    expect(await state.jobs.get('history-1')).toMatchObject({
      status: 'dead',
      attempts: 2,
      lastErrorCode: 'timed_out',
    });
    await state.db.close();
  });
});

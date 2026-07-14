import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { pipeCsvDownload, pipeCsvEntriesZip, writeCsvEvents } from './exportStreams';
import type { QueryResultEvent, QueryResultEventInput } from '../query/resultEvents';

const columns = [{ name: 'id', type: 'bigint' }];

function throwCleanupFailure(): never {
  throw new Error('event cleanup failed');
}

function eventsFor(rows: unknown[][]): AsyncGenerator<QueryResultEvent> {
  return (async function* (): AsyncGenerator<QueryResultEvent> {
    yield { type: 'columns', columns };
    for (const row of rows) yield { type: 'row', row };
  })();
}

function output(chunks: Buffer[]): Parameters<typeof pipeCsvEntriesZip>[0] {
  return {
    write: vi.fn(async (chunk: string | Uint8Array) => {
      chunks.push(Buffer.from(typeof chunk === 'string' ? chunk : chunk));
    }),
  } as unknown as Parameters<typeof pipeCsvEntriesZip>[0];
}

async function zipBytes(
  entries: ReadonlyArray<{ entryName: string; events: QueryResultEventInput }>,
) {
  const chunks: Buffer[] = [];
  await pipeCsvEntriesZip(output(chunks), entries, new AbortController().signal);
  return Buffer.concat(chunks);
}

describe('export stream bridges', () => {
  it('waits for Node Writable drain before requesting the next event', async () => {
    const stream = new PassThrough();
    const originalWrite = stream.write.bind(stream);
    let writeCount = 0;
    stream.write = ((chunk: string | Uint8Array) => {
      writeCount += 1;
      if (writeCount === 1) return false;
      return originalWrite(chunk);
    }) as typeof stream.write;

    let settled = false;
    const pending = writeCsvEvents(eventsFor([[1], [2]]), stream, { gzip: false }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writeCount).toBe(1);
    expect(settled).toBe(false);

    stream.emit('drain');
    await pending;
    expect(writeCount).toBe(3);
    expect(settled).toBe(true);
  });

  it('opens workflow ResultStore inputs one entry at a time and keeps ZIP bytes deterministic', async () => {
    const opened: string[] = [];
    let active = 0;
    let maxActive = 0;
    const makeInput =
      (name: string, row: number): QueryResultEventInput =>
      async () => {
        opened.push(name);
        return (async function* (): AsyncGenerator<QueryResultEvent> {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            yield { type: 'columns', columns };
            yield { type: 'row', row: [row] };
          } finally {
            active -= 1;
          }
        })();
      };
    const entries = [
      { entryName: 'a.csv', events: makeInput('a', 1) },
      { entryName: 'b.csv', events: makeInput('b', 2) },
    ];

    const first = await zipBytes(entries);
    const second = await zipBytes(entries);

    expect(opened).toEqual(['a', 'b', 'a', 'b']);
    expect(maxActive).toBe(1);
    expect(first.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(first.equals(second)).toBe(true);
  });

  it('rejects the first ZIP source failure without opening later entries', async () => {
    let sourceClosed = false;
    const first: QueryResultEventInput = async () =>
      (async function* (): AsyncGenerator<QueryResultEvent> {
        try {
          yield { type: 'columns', columns };
          throw new Error('zip source failed');
        } finally {
          sourceClosed = true;
        }
      })();
    const later = vi.fn(async () => eventsFor([[2]]));

    await expect(
      zipBytes([
        { entryName: 'first.csv', events: first },
        { entryName: 'later.csv', events: later },
      ]),
    ).rejects.toThrow('zip source failed');
    expect(sourceClosed).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it('keeps ZIP cleanup errors secondary to the primary output failure', async () => {
    const controller = new AbortController();
    let startSource!: () => void;
    const sourceStarted = new Promise<void>((resolve) => {
      startSource = resolve;
    });
    let finalized = false;
    const events: QueryResultEventInput = async (signal) =>
      (async function* (): AsyncGenerator<QueryResultEvent> {
        try {
          startSource();
          yield { type: 'columns', columns };
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        } finally {
          finalized = true;
          throwCleanupFailure();
        }
      })();
    const out = {
      write: vi.fn(async () => {
        await sourceStarted;
        controller.abort();
        throw new Error('primary output failed');
      }),
    } as unknown as Parameters<typeof pipeCsvEntriesZip>[0];

    await expect(
      pipeCsvEntriesZip(out, [{ entryName: 'query.csv', events }], controller.signal),
    ).rejects.toThrow('primary output failed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finalized).toBe(true);
  });

  it('closes the event source when the response writer aborts', async () => {
    const controller = new AbortController();
    let closed = false;
    const events = (async function* (): AsyncGenerator<QueryResultEvent> {
      try {
        yield { type: 'columns', columns };
        await new Promise<void>(() => undefined);
      } finally {
        closed = true;
      }
    })();
    const writes: string[] = [];
    const out = {
      write: vi.fn(async (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        controller.abort();
      }),
    } as unknown as Parameters<typeof pipeCsvDownload>[0];

    await pipeCsvDownload(out, 'query.csv', events, {
      gzip: false,
      zip: false,
      signal: controller.signal,
    });

    expect(writes).toEqual(['id\r\n']);
    expect(closed).toBe(true);
  });

  it.each([
    ['pump failure', false],
    ['pump abort', true],
  ])('cleans the event source when gzip readable pump has %s', async (_label, abort) => {
    const controller = new AbortController();
    if (abort) controller.abort();
    let closed = false;
    const events = (async function* (): AsyncGenerator<QueryResultEvent> {
      try {
        yield { type: 'columns', columns };
      } finally {
        closed = true;
      }
    })();
    const pumpError = Object.assign(new Error('gzip pump failed'), {
      name: abort ? 'AbortError' : 'Error',
    });
    const out = {
      pipe: vi.fn(() => Promise.reject(pumpError)),
      write: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof pipeCsvDownload>[0];

    await expect(
      pipeCsvDownload(out, 'query.csv', events, {
        gzip: true,
        zip: false,
        signal: controller.signal,
      }),
    ).rejects.toBe(pumpError);
    expect(closed).toBe(true);
  });

  it('propagates source and destination failures while closing both sides', async () => {
    let sourceClosed = false;
    const source = (async function* (): AsyncGenerator<QueryResultEvent> {
      try {
        yield { type: 'columns', columns };
        throw new Error('source failed');
      } finally {
        sourceClosed = true;
      }
    })();
    const destination = new PassThrough();
    destination.on('error', () => undefined);

    await expect(writeCsvEvents(source, destination, { gzip: false })).rejects.toThrow(
      'source failed',
    );
    expect(sourceClosed).toBe(true);
    expect(destination.destroyed).toBe(true);

    let destinationClosed = false;
    const destinationSource = (async function* (): AsyncGenerator<QueryResultEvent> {
      try {
        yield { type: 'columns', columns };
      } finally {
        destinationClosed = true;
      }
    })();
    const failingDestination = new PassThrough();
    failingDestination.on('error', () => undefined);
    failingDestination.write = (() => {
      throw new Error('destination failed');
    }) as typeof failingDestination.write;

    await expect(
      writeCsvEvents(destinationSource, failingDestination, { gzip: false }),
    ).rejects.toThrow('destination failed');
    expect(destinationClosed).toBe(true);
    expect(failingDestination.destroyed).toBe(true);

    let asyncDestinationSourceClosed = false;
    const asyncDestinationSource = (async function* (): AsyncGenerator<QueryResultEvent> {
      try {
        yield { type: 'columns', columns };
        yield { type: 'row', row: [1] };
      } finally {
        asyncDestinationSourceClosed = true;
      }
    })();
    const asyncFailingDestination = new PassThrough();
    asyncFailingDestination.on('error', () => undefined);
    asyncFailingDestination._write = (_chunk, _encoding, callback) => {
      queueMicrotask(() => callback(new Error('async destination failed')));
    };

    await expect(
      writeCsvEvents(asyncDestinationSource, asyncFailingDestination, { gzip: false }),
    ).rejects.toThrow('async destination failed');
    expect(asyncDestinationSourceClosed).toBe(true);
    expect(asyncFailingDestination.destroyed).toBe(true);

    let gzipDestinationSourceClosed = false;
    const gzipDestinationSource = (async function* (): AsyncGenerator<QueryResultEvent> {
      try {
        yield { type: 'columns', columns };
        yield { type: 'row', row: [1] };
      } finally {
        gzipDestinationSourceClosed = true;
      }
    })();
    const gzipFailingDestination = new PassThrough();
    gzipFailingDestination.on('error', () => undefined);
    gzipFailingDestination._write = (_chunk, _encoding, callback) => {
      queueMicrotask(() => callback(new Error('gzip destination failed')));
    };

    await expect(
      writeCsvEvents(gzipDestinationSource, gzipFailingDestination, { gzip: true }),
    ).rejects.toThrow('gzip destination failed');
    expect(gzipDestinationSourceClosed).toBe(true);
    expect(gzipFailingDestination.destroyed).toBe(true);

    let gzipSourceClosed = false;
    const gzipController = new AbortController();
    const gzipSource = (async function* (): AsyncGenerator<QueryResultEvent> {
      try {
        yield { type: 'columns', columns };
        await new Promise<void>((resolve) => {
          gzipController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        gzipSourceClosed = true;
      }
    })();
    const gzipDestination = new PassThrough();
    gzipDestination.on('error', () => undefined);
    const gzipPending = writeCsvEvents(gzipSource, gzipDestination, {
      gzip: true,
      signal: gzipController.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    gzipController.abort();

    await expect(gzipPending).rejects.toMatchObject({ name: 'AbortError' });
    expect(gzipSourceClosed).toBe(true);
    expect(gzipDestination.destroyed).toBe(true);
  });
});

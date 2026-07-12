// AI providerから受信するSSEの改行形式、チャンク境界とdata連結を検証する。
import { describe, expect, it } from 'vitest';

import { parseSseDataLines, type SseParseLimits } from './sse';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(chunks: string[], limits?: SseParseLimits): Promise<string[]> {
  const payloads: string[] = [];
  for await (const payload of parseSseDataLines(streamFromChunks(chunks), limits)) {
    payloads.push(payload);
  }
  return payloads;
}

describe('parseSseDataLines', () => {
  it.each([
    ['LF', ['data: first\n\ndata: second\n\n']],
    ['CRLF', ['data: first\r\n\r\ndata: second\r\n\r\n']],
    ['CR', ['data: first\r\rdata: second\r\r']],
  ])('%s の空行でイベントを分割する', async (_name, chunks) => {
    await expect(collect(chunks)).resolves.toEqual(['first', 'second']);
  });

  it('CRLF がチャンク境界をまたいでもイベントを分割する', async () => {
    await expect(
      collect(['data: first\r', '\n\r', '\ndata: second\r\n', '\r', '\n']),
    ).resolves.toEqual(['first', 'second']);
  });

  it('複数の data 行を改行で連結し、コメントと他フィールドを無視する', async () => {
    await expect(
      collect([': keep-alive\r\nevent: message\r\ndata: first\r\ndata: second\r\n\r\n']),
    ).resolves.toEqual(['first\nsecond']);
  });

  it('イベント終端前にストリームが終わっても受信済みの data を返す', async () => {
    await expect(collect(['data: partial\r\ndata: response'])).resolves.toEqual([
      'partial\nresponse',
    ]);
  });

  it('単一イベントの byte 上限を超えた応答を拒否する', async () => {
    await expect(
      collect(['data: 123456789'], { maxEventBytes: 8, maxStreamBytes: 100 }),
    ).rejects.toMatchObject({ detail: { code: 'INVALID_RESPONSE' } });
  });

  it('多バイト文字の未完イベントを byte 上限で直ちに拒否する', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${'あ'.repeat(400_000)}`));
      },
    });
    const consuming = (async () => {
      for await (const payload of parseSseDataLines(stream)) void payload;
    })();

    const outcome = await Promise.race([
      consuming.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), 100),
      ),
    ]);

    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: { detail: { code: 'INVALID_RESPONSE' } },
    });
  });

  it('ストリーム全体の byte 上限を超えた応答を拒否する', async () => {
    await expect(
      collect(['data: a\n\n', 'data: b\n\n'], { maxEventBytes: 100, maxStreamBytes: 15 }),
    ).rejects.toMatchObject({ detail: { code: 'INVALID_RESPONSE' } });
  });

  it('利用側が早期終了したとき provider のストリームを cancel する', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\ndata: second\n\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const payloads = parseSseDataLines(stream);

    await expect(payloads.next()).resolves.toEqual({ value: 'first', done: false });
    await payloads.return(undefined);

    expect(canceled).toBe(true);
  });

  it('cancel が未解決でもサイズエラーを呼び出し元へ返す', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 123456789'));
      },
      cancel() {
        canceled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const consuming = (async () => {
      for await (const payload of parseSseDataLines(stream, {
        maxEventBytes: 8,
        maxStreamBytes: 100,
      })) {
        void payload;
      }
    })();

    const outcome = await Promise.race([
      consuming.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), 100),
      ),
    ]);

    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: { detail: { code: 'INVALID_RESPONSE' } },
    });
    expect(canceled).toBe(true);
  });

  it('利用側の早期終了を未解決のcancelでブロックしない', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\ndata: second\n\n'));
      },
      cancel() {
        canceled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const payloads = parseSseDataLines(stream);
    await payloads.next();

    const outcome = await Promise.race([
      payloads.return(undefined).then(() => 'returned'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(outcome).toBe('returned');
    expect(canceled).toBe(true);
  });
});

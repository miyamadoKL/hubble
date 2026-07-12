/** StrictSseBridge の失敗伝播と終了順序を実際の Hono stream で検証する。 */
import { describe, expect, it, vi } from 'vitest';
import { SSEStreamingApi } from 'hono/streaming';
import { StrictSseBridge } from './strictSseBridge';

function createFixture(onFailure = vi.fn()) {
  const transport = new TransformStream<Uint8Array, Uint8Array>();
  const stream = new SSEStreamingApi(transport.writable, transport.readable);
  const bridge = new StrictSseBridge(stream, { onFailure });
  const reader = stream.responseReadable.getReader();
  return { bridge, onFailure, reader, stream };
}

describe('StrictSseBridge', () => {
  it('response body の cancel を write と closed の rejection へ伝える', async () => {
    const { bridge, onFailure, reader, stream } = createFixture();
    const firstWrite = bridge.write('event: state\n\n');
    const firstRead = reader.read();
    await Promise.all([firstWrite, firstRead]);

    await reader.cancel(new Error('client disconnected'));

    await expect(
      bridge.closed.then(
        () => 'fulfilled',
        () => 'rejected',
      ),
    ).resolves.toBe('rejected');
    await expect(
      bridge.write('event: rows\n\n').then(
        () => 'fulfilled',
        () => 'rejected',
      ),
    ).resolves.toBe('rejected');
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
    expect(stream.aborted).toBe(true);
    await bridge.abort();
  });

  it('normal close は frame を送ってから pipe 完了まで待つ', async () => {
    const { bridge, onFailure, reader, stream } = createFixture();
    const write = bridge.write('event: done\n\n');
    const first = await reader.read();
    await write;

    await bridge.close();
    await stream.close();
    const end = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe('event: done\n\n');
    expect(end.done).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
    await expect(bridge.closed).resolves.toBeUndefined();
  });

  it('abort を冪等に実行し、意図した中断を failure callback へ出さない', async () => {
    const { bridge, onFailure, reader } = createFixture();
    const reason = new Error('stop');

    await Promise.all([bridge.abort(reason), bridge.abort(reason)]);

    await expect(bridge.closed).rejects.toBe(reason);
    await expect(bridge.write('event: rows\n\n')).rejects.toBeDefined();
    expect(onFailure).not.toHaveBeenCalled();
    await reader.cancel().catch(() => undefined);
  });
});

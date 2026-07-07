/**
 * ai.ts（AI アシスタント SSE クライアント）のテスト。
 * fetch を偽装して SSE レスポンスを ReadableStream で返し、イベントの
 * パースと検証、HTTP エラーの ApiClientError 変換を確認する。
 */
import { describe, expect, it } from 'vitest';
import type { AiAssistEvent } from '@hubble/contracts';
import { streamAiAssist } from './ai';
import { ApiClientError } from './client';

/** 文字列チャンク列から SSE レスポンスの Response を組み立てる。 */
function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/** 固定の Response を返す fetch の偽装。 */
function fakeFetch(res: Response): typeof fetch {
  return () => Promise.resolve(res);
}

describe('streamAiAssist', () => {
  const request = { task: 'explain', sql: 'SELECT 1' } as const;

  it('delta と done をパースしてハンドラへ渡す', async () => {
    const events: AiAssistEvent[] = [];
    const res = sseResponse([
      'event: delta\ndata: {"type":"delta","text":"SELECT"}\n\n',
      // フレームがチャンク境界をまたぐケース。
      'event: delta\ndata: {"type":"delta","te',
      'xt":" 1"}\n\n: keep-alive\n\n',
      'event: done\ndata: {"type":"done","text":"SELECT 1","sql":"SELECT 1"}\n\n',
    ]);
    await streamAiAssist(
      request,
      { onEvent: (e) => events.push(e) },
      { fetchImpl: fakeFetch(res) },
    );
    expect(events).toEqual([
      { type: 'delta', text: 'SELECT' },
      { type: 'delta', text: ' 1' },
      { type: 'done', text: 'SELECT 1', sql: 'SELECT 1' },
    ]);
  });

  it('error イベントで終了する', async () => {
    const events: AiAssistEvent[] = [];
    const res = sseResponse([
      'event: error\ndata: {"type":"error","error":{"code":"AI_PROVIDER_ERROR","message":"boom"}}\n\n',
      // error 以降のフレームは読まれない。
      'event: delta\ndata: {"type":"delta","text":"ignored"}\n\n',
    ]);
    await streamAiAssist(
      request,
      { onEvent: (e) => events.push(e) },
      { fetchImpl: fakeFetch(res) },
    );
    expect(events).toEqual([
      { type: 'error', error: { code: 'AI_PROVIDER_ERROR', message: 'boom' } },
    ]);
  });

  it('壊れたフレームと未知のイベントは無視する', async () => {
    const events: AiAssistEvent[] = [];
    const res = sseResponse([
      'data: not-json\n\n',
      'data: {"type":"unknown"}\n\n',
      'event: done\ndata: {"type":"done","text":"ok"}\n\n',
    ]);
    await streamAiAssist(
      request,
      { onEvent: (e) => events.push(e) },
      { fetchImpl: fakeFetch(res) },
    );
    expect(events).toEqual([{ type: 'done', text: 'ok' }]);
  });

  it('非 2xx はエラーエンベロープ付きの ApiClientError を投げる', async () => {
    const res = new Response(
      JSON.stringify({ error: { code: 'AI_DISABLED', message: 'AI assistant is not configured' } }),
      { status: 501, headers: { 'content-type': 'application/json' } },
    );
    await expect(
      streamAiAssist(request, { onEvent: () => {} }, { fetchImpl: fakeFetch(res) }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiClientError);
      expect((err as ApiClientError).status).toBe(501);
      expect((err as ApiClientError).detail.code).toBe('AI_DISABLED');
      return true;
    });
  });
});

import { TrinoTransportError, trinoError } from '../errors';
import {
  emptySessionMutations,
  type TrinoRequestContext,
  type TrinoSessionMutations,
  type TrinoStatementResponse,
} from './types';

export interface TrinoClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  /** `X-Trino-User` value. */
  user: string;
  /** Default `X-Trino-Source` for user queries. */
  source: string;
  /** Backoff floor in ms (default 20). */
  backoffStartMs?: number;
  /** Per-poll backoff increment in ms (default 20). */
  backoffStepMs?: number;
  /** Backoff ceiling in ms (default 1000). */
  backoffMaxMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function basicAuthHeader(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

/** Encode session properties as `k=v,k2=v2`, percent-encoding values. */
function encodeSession(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join(',');
}

/**
 * Thin wrapper over Trino's `/v1/statement` REST protocol.
 *
 * - `start()` issues the initial POST.
 * - `advance()` follows one `nextUri` (caller drives the loop so it can stream
 *   rows incrementally and react to cancellation between pages).
 * - `cancel()` issues a DELETE against the current `nextUri`.
 *
 * Session mutations from `x-trino-set-*` headers are accumulated into the
 * passed `TrinoSessionMutations` so the caller can reflect them on completion.
 */
export class TrinoClient {
  private readonly baseUrl: string;
  private readonly opts: Required<
    Pick<TrinoClientOptions, 'backoffStartMs' | 'backoffStepMs' | 'backoffMaxMs'>
  > &
    TrinoClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TrinoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.opts = {
      ...options,
      backoffStartMs: options.backoffStartMs ?? 20,
      backoffStepMs: options.backoffStepMs ?? 20,
      backoffMaxMs: options.backoffMaxMs ?? 1000,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
  }

  /** Backoff delay for the Nth poll (0-based): 20ms + 20ms*N, capped at 1000ms. */
  backoffMs(attempt: number): number {
    const { backoffStartMs, backoffStepMs, backoffMaxMs } = this.opts;
    return Math.min(backoffStartMs + backoffStepMs * attempt, backoffMaxMs);
  }

  private commonHeaders(ctx: TrinoRequestContext): Headers {
    const headers = new Headers();
    // Impersonation (design.md §11): per-request `ctx.user` overrides the
    // technical user; metadata queries omit it and run as the technical user.
    const trinoUser = ctx.user && ctx.user.trim() !== '' ? ctx.user : this.opts.user;
    headers.set('X-Trino-User', trinoUser);
    headers.set('Authorization', basicAuthHeader(this.opts.username, this.opts.password));
    const source = ctx.source && ctx.source.trim() !== '' ? ctx.source : this.opts.source;
    headers.set('X-Trino-Source', source);
    if (ctx.catalog) headers.set('X-Trino-Catalog', ctx.catalog);
    if (ctx.schema) headers.set('X-Trino-Schema', ctx.schema);
    if (ctx.sessionProperties && Object.keys(ctx.sessionProperties).length > 0) {
      headers.set('X-Trino-Session', encodeSession(ctx.sessionProperties));
    }
    return headers;
  }

  /** Issue the initial statement POST. */
  async start(
    statement: string,
    ctx: TrinoRequestContext,
    mutations: TrinoSessionMutations,
    signal?: AbortSignal,
  ): Promise<TrinoStatementResponse> {
    const headers = this.commonHeaders(ctx);
    headers.set('Content-Type', 'text/plain');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/statement`, {
        method: 'POST',
        headers,
        body: statement,
        signal,
      });
    } catch (err) {
      throw new TrinoTransportError(
        `Failed to reach Trino: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.decode(res, mutations);
  }

  /** Follow a single `nextUri`, applying any backoff the caller requests. */
  async advance(
    nextUri: string,
    ctx: TrinoRequestContext,
    mutations: TrinoSessionMutations,
    signal?: AbortSignal,
  ): Promise<TrinoStatementResponse> {
    const headers = this.commonHeaders(ctx);
    let res: Response;
    try {
      res = await this.fetchImpl(nextUri, { method: 'GET', headers, signal });
    } catch (err) {
      throw new TrinoTransportError(
        `Failed to poll Trino nextUri: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.decode(res, mutations);
  }

  /** Issue a DELETE to cancel an in-flight query at its current `nextUri`. */
  async cancel(nextUri: string, ctx: TrinoRequestContext): Promise<void> {
    const headers = this.commonHeaders(ctx);
    try {
      await this.fetchImpl(nextUri, { method: 'DELETE', headers });
    } catch {
      // Best-effort: a failed cancel propagation should not surface to the user.
    }
  }

  /** Sleep using the configured backoff for the given (0-based) attempt. */
  async waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await this.sleep(this.backoffMs(attempt));
  }

  private applySessionHeaders(res: Response, mutations: TrinoSessionMutations): void {
    const setCatalog = res.headers.get('x-trino-set-catalog');
    if (setCatalog) mutations.setCatalog = setCatalog;
    const setSchema = res.headers.get('x-trino-set-schema');
    if (setSchema) mutations.setSchema = setSchema;

    // `X-Trino-Set-Session: name=value` may appear multiple times.
    const setSession = res.headers.get('x-trino-set-session');
    if (setSession) {
      for (const part of setSession.split(',')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const value = decodeURIComponent(part.slice(eq + 1).trim());
        if (name) mutations.setSession[name] = value;
      }
    }
    const clearSession = res.headers.get('x-trino-clear-session');
    if (clearSession) {
      for (const name of clearSession.split(',')) {
        const trimmed = name.trim();
        if (trimmed) mutations.clearSession.push(trimmed);
      }
    }
  }

  private async decode(
    res: Response,
    mutations: TrinoSessionMutations,
  ): Promise<TrinoStatementResponse> {
    this.applySessionHeaders(res, mutations);

    const text = await res.text();
    if (res.status >= 300) {
      // Try to surface a structured Trino error from the body if present.
      const parsed = safeJson(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error) {
        throw trinoError((parsed as TrinoStatementResponse).error!);
      }
      throw new TrinoTransportError(`Trino returned HTTP ${res.status}: ${truncate(text, 500)}`);
    }

    const payload = safeJson(text);
    if (!payload || typeof payload !== 'object') {
      throw new TrinoTransportError('Trino returned a non-JSON response');
    }
    const response = payload as TrinoStatementResponse;
    if (response.error) {
      throw trinoError(response.error);
    }
    return response;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export { emptySessionMutations };

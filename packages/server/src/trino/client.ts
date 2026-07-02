import { TrinoTransportError, trinoError } from '../errors';
import {
  emptySessionMutations,
  type TrinoRequestContext,
  type TrinoSessionMutations,
  type TrinoStatementResponse,
} from './types';

/**
 * このファイルは Trino の `/v1/statement` REST プロトコルに対する薄い HTTP
 * クライアント `TrinoClient` を提供する。クエリの「開始」「nextUri の追走」
 * 「キャンセル」という 3 操作のみを HTTP リクエストへマッピングし、ループの
 * 制御 (いつ次のページを取りに行くか、いつ止めるか) は呼び出し側
 * (trino/runner.ts の runToCompletion、schedule/execute.ts の drainStatement、
 * ストリーミング用の registry 等) に委ねる薄いレイヤーとして設計されている。
 */

/** `TrinoClient` の構築オプション。 */
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

// 日本語: TrinoClientOptions.sleepImpl 省略時の既定実装。実際に ms ミリ秒待つ。
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 日本語: Trino への Basic 認証ヘッダー値 ("Basic base64(user:pass)") を組み立てる。
function basicAuthHeader(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

/** Encode session properties as `k=v,k2=v2`, percent-encoding values. */
// 日本語: X-Trino-Session ヘッダーの値を組み立てる。複数のセッションプロパティを
// カンマ区切りで並べ、値部分のみ percent-encode する (Trino プロトコルの規約)。
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
 *
 * 日本語: このクラスはループ制御を持たない (=呼び出し側が nextUri をどこまで
 * 追走するか判断する)。これにより、行データをストリームで即座にクライアントへ
 * 転送したい経路 (通常のクエリ実行) と、完走するまで裏で貯め込みたい経路
 * (メタデータ取得、スケジュール実行) の両方に同じクライアントを使い回せる。
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
    // 末尾のスラッシュを除去し、以後 `${baseUrl}/v1/statement` のように
    // 単純結合できるようにする。
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
  // 日本語: nextUri をポーリングする際の待ち時間を線形に増加させ、上限で
  // 頭打ちにする単純な計算式。attempt はデータが来なかった連続回数
  // (呼び出し側の idleAttempt) を渡すのが典型的な使い方。
  backoffMs(attempt: number): number {
    const { backoffStartMs, backoffStepMs, backoffMaxMs } = this.opts;
    return Math.min(backoffStartMs + backoffStepMs * attempt, backoffMaxMs);
  }

  // 日本語: start()/advance()/cancel() の全リクエストで共通する HTTP ヘッダー
  // (認証、ユーザー、ソース、カタログ/スキーマ、セッションプロパティ) を組み立てる。
  private commonHeaders(ctx: TrinoRequestContext): Headers {
    const headers = new Headers();
    // Impersonation (design.md §11): per-request `ctx.user` overrides the
    // technical user; metadata queries omit it and run as the technical user.
    // 日本語: ctx.user が空でなければそれを X-Trino-User に使う (ユーザー
    // なりすまし実行)。未指定ならクライアント全体のテクニカルユーザーを使う。
    const trinoUser = ctx.user && ctx.user.trim() !== '' ? ctx.user : this.opts.user;
    headers.set('X-Trino-User', trinoUser);
    headers.set('Authorization', basicAuthHeader(this.opts.username, this.opts.password));
    // 日本語: X-Trino-Source も同様に ctx 側の指定を優先し、無ければクライアント既定値。
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
  // 日本語: /v1/statement プロトコルの起点。ステートメント文字列を text/plain の
  // body として POST し、最初のレスポンスページ (通常 QUEUED 状態 + nextUri) を
  // 受け取る。以後は呼び出し側が advance() で nextUri を追走する。
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
      // 日本語: fetch 自体が失敗した (ネットワーク到達不可等) 場合は
      // TrinoTransportError として呼び出し側 (retry.ts が transient と分類) に伝える。
      throw new TrinoTransportError(
        `Failed to reach Trino: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.decode(res, mutations);
  }

  /** Follow a single `nextUri`, applying any backoff the caller requests. */
  // 日本語: 直前のレスポンスに含まれていた nextUri へ GET する。呼び出し側は
  // backoffMs()/waitBackoff() を使って呼び出し間隔を自分で制御する
  // (このメソッド自体は待たない)。
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
      // 日本語: キャンセル自体が失敗しても (Trino に届かなくても) ユーザー操作
      // としてはすでに完了扱いにする。エラーは握りつぶす。
    }
  }

  /** Sleep using the configured backoff for the given (0-based) attempt. */
  // 日本語: backoffMs(attempt) が返す時間だけ実際に待つ。signal が既に
  // abort 済みなら待たずに即座に返る (キャンセル済みクエリで無駄に待たないため)。
  async waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await this.sleep(this.backoffMs(attempt));
  }

  // 日本語: レスポンスヘッダーの x-trino-set-catalog / x-trino-set-schema /
  // x-trino-set-session / x-trino-clear-session を読み取り、mutations
  // オブジェクトへ蓄積する。呼び出し側はクエリ完了後にこれをセッション
  // スナップショットへ反映する (SET CATALOG 等の効果を次のクエリへ引き継ぐため)。
  private applySessionHeaders(res: Response, mutations: TrinoSessionMutations): void {
    const setCatalog = res.headers.get('x-trino-set-catalog');
    if (setCatalog) mutations.setCatalog = setCatalog;
    const setSchema = res.headers.get('x-trino-set-schema');
    if (setSchema) mutations.setSchema = setSchema;

    // `X-Trino-Set-Session: name=value` may appear multiple times.
    // 日本語: SET SESSION は複数回のヘッダーとして、あるいはカンマ区切りの
    // 複数エントリとして返る可能性があるため split(',') で分解して個別に処理する。
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
    // 日本語: RESET SESSION 相当。クリアすべきプロパティ名の一覧をカンマ区切りで受け取る。
    const clearSession = res.headers.get('x-trino-clear-session');
    if (clearSession) {
      for (const name of clearSession.split(',')) {
        const trimmed = name.trim();
        if (trimmed) mutations.clearSession.push(trimmed);
      }
    }
  }

  // 日本語: start()/advance() の共通後処理。セッションヘッダーの反映 →
  // ボディの読み取り → ステータスコード/JSON 妥当性/error フィールドの検査、
  // という順でレスポンスを検証し、正常なら TrinoStatementResponse を返す。
  // 異常系はすべて例外 (TrinoTransportError もしくは trinoError() が生成する
  // TrinoQueryError) として投げる。
  private async decode(
    res: Response,
    mutations: TrinoSessionMutations,
  ): Promise<TrinoStatementResponse> {
    this.applySessionHeaders(res, mutations);

    const text = await res.text();
    if (res.status >= 300) {
      // Try to surface a structured Trino error from the body if present.
      // 日本語: HTTP レベルではエラーでも、ボディに Trino の構造化エラー
      // (error フィールド) が含まれていればそちらを優先して例外化する。
      const parsed = safeJson(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error) {
        throw trinoError((parsed as TrinoStatementResponse).error!);
      }
      // 構造化エラーが無ければ、ステータスコードと本文の先頭部分のみを
      // 含む transport エラーとして扱う。
      throw new TrinoTransportError(`Trino returned HTTP ${res.status}: ${truncate(text, 500)}`);
    }

    const payload = safeJson(text);
    if (!payload || typeof payload !== 'object') {
      throw new TrinoTransportError('Trino returned a non-JSON response');
    }
    const response = payload as TrinoStatementResponse;
    if (response.error) {
      // 日本語: HTTP ステータスは 2xx でもボディに error が含まれるケース
      // (Trino の設計上あり得る) をここで捕捉する。
      throw trinoError(response.error);
    }
    return response;
  }
}

// 日本語: レスポンスボディを JSON.parse し、失敗時は例外を投げずに undefined を
// 返すユーティリティ (呼び出し側で「JSON でなかった」ことを分岐処理するため)。
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// 日本語: エラーメッセージに埋め込む本文プレビューが長くなりすぎないよう、
// max 文字を超える場合は切り詰めて末尾に "…" を付ける。
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export { emptySessionMutations };

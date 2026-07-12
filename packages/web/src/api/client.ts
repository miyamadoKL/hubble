/**
 * API クライアントの共通基盤ファイル。
 *
 * サーバー（packages/server）が公開する REST API を呼び出すための、型安全な
 * fetch ラッパー `apiFetch` と、そのエラー型 `ApiClientError` を提供する。
 * 各エンドポイント固有の呼び出し関数（history.ts, metadata.ts, notebooks.ts,
 * savedQueries.ts, schedules.ts）はいずれもここで定義される `apiFetch` を
 * 経由してリクエストを送り、レスポンスを @hubble/contracts の zod スキーマで
 * 検証する。これにより、サーバーとクライアントの間で型とスキーマの整合性が
 * 保証される（レスポンスがスキーマに合わない場合は例外として扱われる）。
 */
import {
  apiErrorSchema,
  appConfigSchema,
  apiRoutes,
  meResponseSchema,
  type ApiErrorDetail,
  type AppConfig,
  type MeResponse,
} from '@hubble/contracts';
import type { ZodType } from 'zod';

/**
 * Error thrown by the API client. Carries the parsed `{ error }` envelope
 * when the server returns one, plus the HTTP status.
 *
 * API クライアントが送出する共通エラークラス。
 * サーバーが返す `{ error: { code, message, ... } }` 形式のエラーエンベロープ
 * をパースした内容（detail）と、レスポンスの HTTP ステータス
 * コード（status）を保持する。呼び出し側はこのクラスを catch することで、
 * HTTP エラーとレスポンススキーマ不一致エラーの両方を統一的に扱える。
 */
export class ApiClientError extends Error {
  /** レスポンスの HTTP ステータスコード（例: 404, 500）。 */
  readonly status: number;
  /** サーバー由来、またはこのクライアントが生成した合成エラーの詳細情報。 */
  readonly detail: ApiErrorDetail;

  constructor(status: number, detail: ApiErrorDetail) {
    // Error のメッセージにはサーバー側のエラーメッセージをそのまま使う。
    super(detail.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * レスポンスが非 2xx だった場合に呼ばれ、エラーボディを ApiErrorDetail に変換する。
 * サーバーがエラーエンベロープ（`{ error: {...} }`）を JSON で返している場合は
 * それをそのまま採用し、JSON パースに失敗した場合や
 * スキーマに一致しなかった場合は HTTP ステータスのみを使った合成エラーを返す。
 */
async function parseErrorBody(res: Response): Promise<ApiErrorDetail> {
  try {
    // レスポンスボディを JSON としてパースを試みる。
    const json = await res.json();
    // @hubble/contracts のエラーエンベロープ用スキーマで検証する。
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) return parsed.data.error;
  } catch {
    // JSON パースに失敗した場合（ボディが無い/JSON でない等）は
    // 何もせず下のフォールバック処理へ進む。
    // fall through to a synthetic error below
  }
  // サーバー側のエラーエンベロープが得られなかった場合の合成エラー。
  // ステータスコードのみを埋め込んだ汎用メッセージを返す。
  return {
    code: 'HTTP_ERROR',
    message: `Request failed with status ${res.status}`,
  };
}

/**
 * `apiFetch` に渡すリクエストオプション。
 * 標準の `RequestInit` から `body`（文字列化前の任意の値を受け付けるため上書き）を
 * 除いたものに、クエリ文字列用の `query` を追加した型。
 */
export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** JSON にシリアライズしてリクエストボディとして送る値（省略時は body なし）。 */
  body?: unknown;
  /** Query-string parameters appended to the path. */
  // パスの末尾に付与するクエリパラメータ。値が undefined のキーは除外される。
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * パスとクエリパラメータから最終的なリクエスト URL を組み立てる。
 * query が未指定、またはすべての値が undefined の場合はクエリ文字列を付けない。
 */
function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // undefined の値は「指定なし」として扱い、クエリ文字列に含めない。
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  // クエリが空文字列になる場合（全キーが undefined 等）はそのままのパスを返す。
  return qs ? `${path}?${qs}` : path;
}

/**
 * Typed fetch wrapper. Validates the response against `schema` (a zod schema
 * from @hubble/contracts) and throws `ApiClientError` on non-2xx responses
 * or schema mismatches.
 *
 * 型付き fetch ラッパー本体。全ての API 呼び出し関数はこの関数を介して
 * サーバーと通信する。処理の流れは以下の通り。
 * 1. リクエストオプションを組み立てる（JSON ボディがあれば content-type を設定）。
 * 2. fetch を実行する（URL はパス + クエリ文字列）。
 * 3. レスポンスが非 2xx なら、エラーボディをパースして ApiClientError を投げる。
 * 4. レスポンスボディを JSON パースし、渡された zod スキーマで検証する。
 * 5. 検証に失敗した場合も ApiClientError を投げる（INVALID_RESPONSE）。
 * 6. 検証済みの型安全なデータを返す。
 *
 * @param schema  レスポンス JSON を検証するための zod スキーマ（@hubble/contracts 由来）。
 * @param path    リクエスト先のパス（`apiRoutes` から生成されることが多い）。
 * @param options メソッド、ヘッダー、ボディ、クエリパラメータなどのリクエストオプション。
 * @returns       スキーマ検証を通過した、型 T のレスポンスデータ。
 * @throws {ApiClientError} HTTP ステータスが非 2xx の場合、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export async function apiFetch<T>(
  schema: ZodType<T>,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  // body、query、headers を個別に取り出し、残りのオプション（method 等）はそのまま渡す。
  const { body, query, headers, ...rest } = options;
  const init: RequestInit = { ...rest, headers: { ...headers } };

  if (body !== undefined) {
    // body が指定されている場合は JSON としてシリアライズし、
    // content-type ヘッダーを付与する（呼び出し側で上書きされていれば優先される）。
    init.headers = { 'content-type': 'application/json', ...init.headers };
    init.body = JSON.stringify(body);
  }

  // 実際の fetch 呼び出し。URL はパスとクエリパラメータから組み立てる。
  const res = await fetch(buildUrl(path, query), init);

  if (!res.ok) {
    // HTTP ステータスが 2xx でない場合は、エラーボディをパースして例外を投げる。
    throw new ApiClientError(res.status, await parseErrorBody(res));
  }

  // 成功レスポンスの JSON ボディを取得する。
  const json = await res.json();
  // 呼び出し側が指定した zod スキーマでレスポンスの形を検証する。
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // ステータスは 2xx でもスキーマに合わない場合は、
    // クライアント側のバグやサーバーとの契約違反として扱いエラーを投げる。
    throw new ApiClientError(res.status, {
      code: 'INVALID_RESPONSE',
      message: `Response did not match the expected schema: ${parsed.error.message}`,
    });
  }
  // 検証済みのデータ（型 T）を返す。
  return parsed.data;
}

/**
 * 同一 origin のダウンロード API を取得し、成功本文を Blob として返す。
 * 非 2xx 応答は JSON API と同じ `ApiClientError` に変換する。
 * 呼び出し側が object URL を作るため、成功本文はブラウザーのメモリーへ全量保持される。
 * @param path ダウンロード API のパス。
 * @returns 応答本文の Blob。
 * @throws {ApiClientError} HTTP 応答が非 2xx の場合。
 */
export async function apiFetchBlob(path: string): Promise<Blob> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new ApiClientError(res.status, await parseErrorBody(res));
  }
  return res.blob();
}

/**
 * Fetch the public app config.
 * `GET /api/config` を呼び出し、認証不要で公開されているアプリ設定を取得する。
 * @returns アプリ設定（AppConfig）。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchConfig(): Promise<AppConfig> {
  return apiFetch(appConfigSchema, apiRoutes.config());
}

/**
 * Fetch the current authenticated identity.
 * `GET /api/me` を呼び出し、現在リクエストを行っている認証済みユーザーの
 * アイデンティティ情報を取得する。
 * @returns 現在の認証済みユーザー情報（MeResponse）。
 * @throws {ApiClientError} 未認証とリクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchMe(): Promise<MeResponse> {
  return apiFetch(meResponseSchema, apiRoutes.me());
}

// 各エンドポイント固有のファイル（history.ts, metadata.ts 等）から
// パス生成用ヘルパーとして再利用できるよう、apiRoutes をそのまま re-export する。
export { apiRoutes };

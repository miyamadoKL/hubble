/**
 * HTTP 層共通のリクエスト検証ユーティリティ（`packages/server/src/http/validate.ts`）。
 *
 * `packages/server/src/http/` 配下の各ルーター（queryRoutes / scheduleRoutes / storeRoutes /
 * metadataRoutes 等）から共通で使われる、JSON ボディのスキーマ検証とクエリパラメータの
 * パースを提供する。契約（zod スキーマ）は `@hubble/contracts` 側にあり、このファイルは
 * `@hubble/contracts` から zod への直接依存を持たずに zod スキーマを受け取れるよう、
 * 構造的部分型（`SafeParser`）で最小限のインターフェースだけを要求する。
 */
import type { Context } from 'hono';
import { AppError } from '../errors';

/**
 * Minimal structural view of a zod schema — avoids a direct zod dependency.
 *
 * zod スキーマの `safeParse` メソッドだけを要求する構造的インターフェース。このファイルが
 * zod パッケージ自体に直接依存しなくても、zod スキーマをそのまま渡して使えるようにする。
 */
interface SafeParser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/**
 * Parse + validate a JSON body against a zod schema, throwing AppError(400).
 *
 * リクエストボディを JSON としてパースし、渡されたスキーマで検証する共通ヘルパー。
 * 各ルートハンドラの冒頭で `await parseJsonBody(c, someRequestSchema)` の形で呼ばれる。
 * @param c - Hono のリクエストコンテキスト。
 * @param schema - ボディを検証する zod スキーマ（`SafeParser` 互換であればよい）。
 * @returns 検証済みで型付けされたボディデータ。
 * @throws {AppError} ボディが JSON として不正な場合、または `schema` の検証に失敗した場合に
 *   400（後者は `VALIDATION_ERROR` コード付き）を投げる。
 */
export async function parseJsonBody<T>(c: Context, schema: SafeParser<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    // ボディが空、または JSON として構文的に不正な場合はここで 400 にする。
    throw AppError.badRequest('Request body must be valid JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    // zod の issue 一覧を人間が読める1行メッセージに整形して 400 の詳細に含める。
    throw AppError.badRequest(formatIssues(result.error.issues), 'VALIDATION_ERROR');
  }
  return result.data;
}

/**
 * Parse a non-negative integer query param, returning a fallback when absent.
 *
 * クエリ文字列のページング系パラメータ（offset/limit 等）を整数へパースする共通ヘルパー。
 * @param value - `c.req.query(...)` で取得した生の文字列（未指定なら `undefined`）。
 * @param fallback - 値が未指定、空文字、またはパース不能なときに使うデフォルト値。
 * @returns パースされた整数、または `fallback`。
 */
export function intParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** zod の issue 配列を `path: message; path: message` 形式の1行文字列へ整形する。 */
function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}

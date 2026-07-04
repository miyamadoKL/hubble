/**
 * POST /api/queries リクエストのサーバー側正規化と検証。
 */
import { AppError } from '../errors';

/** Trino セッションプロパティ名の許可パターン。 */
const SESSION_PROPERTY_KEY = /^[a-z][a-z0-9_.]*$/i;

/**
 * sessionProperties のキーと値を検証する。違反時は 400。
 * @param props - クライアントから受け取ったセッションプロパティ。
 * @returns 検証済みのオブジェクト（未指定なら undefined）。
 */
export function validateSessionProperties(
  props: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (props === undefined) return undefined;
  for (const [key, value] of Object.entries(props)) {
    if (!SESSION_PROPERTY_KEY.test(key)) {
      throw AppError.badRequest(
        `Invalid session property key: ${JSON.stringify(key)}`,
        'VALIDATION_ERROR',
      );
    }
    if (/[\n\r]/.test(value)) {
      throw AppError.badRequest(
        `Session property value must not contain newlines: ${JSON.stringify(key)}`,
        'VALIDATION_ERROR',
      );
    }
  }
  return props;
}

/**
 * リクエストの maxRows をサーバー設定上限でクランプする。
 * @param requested - クライアント指定値（未指定なら undefined）。
 * @param serverMax - QUERY_MAX_ROWS 由来の上限。
 * @returns 実効 maxRows（未指定なら undefined）。
 */
export function effectiveMaxRows(
  requested: number | undefined,
  serverMax: number,
): number | undefined {
  if (requested === undefined) return undefined;
  return Math.min(requested, serverMax);
}

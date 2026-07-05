/**
 * GitHub OAuth state パラメータの生成と検証。
 *
 * connect リダイレクト時に state を付与し、callback で principal 一致と
 * 有効期限、署名を検証する。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * OAuth state 文字列を生成する。
 * @param encryptionKey - HMAC 署名に使う鍵。
 * @param user - principal user。
 * @param now - 現在時刻 (ms)。
 */
export function createOAuthState(encryptionKey: Buffer, user: string, now: number): string {
  const expires = Math.floor((now + STATE_TTL_MS) / 1000);
  const userB64 = Buffer.from(user, 'utf8').toString('base64url');
  const sig = signState(encryptionKey, user, expires);
  return `${userB64}.${expires}.${sig}`;
}

/**
 * OAuth state を検証する。
 * @param encryptionKey - HMAC 署名に使う鍵。
 * @param state - クエリの state 値。
 * @param expectedUser - 期待する principal user。
 * @param now - 現在時刻 (ms)。
 */
export function verifyOAuthState(
  encryptionKey: Buffer,
  state: string,
  expectedUser: string,
  now: number,
): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [userB64, expiresRaw, sig] = parts as [string, string, string];
  let user: string;
  try {
    user = Buffer.from(userB64, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  if (user !== expectedUser) return false;
  const expires = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expires) || expires * 1000 < now) return false;
  const expectedSig = signState(encryptionKey, user, expires);
  return safeEqual(sig, expectedSig);
}

function signState(encryptionKey: Buffer, user: string, expires: number): string {
  return createHmac('sha256', encryptionKey).update(`${user}.${expires}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

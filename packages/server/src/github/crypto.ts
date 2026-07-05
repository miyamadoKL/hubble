/**
 * GitHub OAuth トークンの AES-256-GCM 暗号化と復号。
 *
 * 永続化層 (github_connections) へ保存する前に access/refresh トークンを
 * 暗号化し、syncService が利用するときに復号する。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 平文トークンを AES-256-GCM で暗号化する。
 * @param key - 32 バイトの暗号鍵。
 * @param plaintext - 暗号化対象のトークン文字列。
 * @returns base64(iv).base64(ciphertext).base64(tag) 形式の文字列。
 */
export function encryptToken(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, ciphertext, tag].map((part) => part.toString('base64')).join('.');
}

/**
 * {@link encryptToken} で生成したペイロードを復号する。
 * @param key - 32 バイトの暗号鍵。
 * @param payload - ドット区切りの暗号文。
 * @returns 復号された平文トークン。
 */
export function decryptToken(key: Buffer, payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token payload format');
  }
  const [ivB64, ciphertextB64, tagB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted token payload components');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * GitHub OAuth トークンの AES-256-GCM 暗号化と復号。
 *
 * 永続化層 (github_connections) へ保存する前に access/refresh トークンを
 * 暗号化し、syncService が利用するときに復号する。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 'v1';
const HKDF_SALT = Buffer.from('hubble/github', 'utf8');
const HKDF_INFO = Buffer.from('oauth-token/aes-256-gcm/v1', 'utf8');

/** GitHub token暗号化に使うactive keyと復号用keyring。 */
export interface TokenEncryptionKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * 平文トークンを AES-256-GCM で暗号化する。
 * @param keyring - active key IDと復号用の鍵集合。
 * @param plaintext - 暗号化対象のトークン文字列。
 * @returns version.keyId.base64(iv).base64(ciphertext).base64(tag) 形式の文字列。
 */
export function encryptToken(keyring: TokenEncryptionKeyring, plaintext: string): string {
  const masterKey = requireKey(keyring, keyring.activeKeyId);
  const key = deriveTokenKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(envelopeAad(keyring.activeKeyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, keyring.activeKeyId, iv, ciphertext, tag]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join('.');
}

/**
 * {@link encryptToken} で生成したペイロードを復号する。
 * 旧3要素形式はkey IDを持たないため、keyring内の全master keyを順に試す。
 * @param keyring - active key IDと復号用の鍵集合。
 * @param payload - ドット区切りの暗号文。
 * @returns 復号された平文トークン。
 */
export function decryptToken(keyring: TokenEncryptionKeyring, payload: string): string {
  const parts = payload.split('.');
  if (parts.length === 3) return decryptLegacyToken(keyring, parts);
  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Invalid encrypted token payload format');
  }
  const [, keyId, ivB64, ciphertextB64, tagB64] = parts as [string, string, string, string, string];
  const key = deriveTokenKey(requireKey(keyring, keyId));
  return decryptAesGcm(key, ivB64, ciphertextB64, tagB64, envelopeAad(keyId));
}

/** 暗号文がactive keyの現行envelopeへ移行済みか判定する。 */
export function tokenNeedsRewrap(keyring: TokenEncryptionKeyring, payload: string): boolean {
  const parts = payload.split('.');
  return parts.length !== 5 || parts[0] !== ENVELOPE_VERSION || parts[1] !== keyring.activeKeyId;
}

function decryptLegacyToken(keyring: TokenEncryptionKeyring, parts: string[]): string {
  const [ivB64, ciphertextB64, tagB64] = parts as [string, string, string];
  const orderedKeys = [
    requireKey(keyring, keyring.activeKeyId),
    ...[...keyring.keys.entries()]
      .filter(([keyId]) => keyId !== keyring.activeKeyId)
      .map(([, key]) => key),
  ];
  for (const key of orderedKeys) {
    try {
      return decryptAesGcm(key, ivB64, ciphertextB64, tagB64);
    } catch {
      // 旧形式にはkey IDがないため、次の候補鍵を試す。
    }
  }
  throw new Error('Encrypted token could not be decrypted with the configured keyring');
}

function decryptAesGcm(
  key: Buffer,
  ivB64: string,
  ciphertextB64: string,
  tagB64: string,
  aad?: Buffer,
): string {
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted token payload components');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function deriveTokenKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, HKDF_INFO, 32));
}

function envelopeAad(keyId: string): Buffer {
  return Buffer.from(`${ENVELOPE_VERSION}.${keyId}`, 'utf8');
}

function requireKey(keyring: TokenEncryptionKeyring, keyId: string): Buffer {
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`Encrypted token references unknown key ID '${keyId}'`);
  if (key.length !== 32) throw new Error(`Token encryption key '${keyId}' must be 32 bytes`);
  return key;
}

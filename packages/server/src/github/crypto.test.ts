import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, tokenNeedsRewrap } from './crypto';

const KEY = Buffer.alloc(32, 7);
const OLD_KEY = Buffer.alloc(32, 8);
const KEYRING = {
  activeKeyId: 'current',
  keys: new Map([
    ['current', KEY],
    ['old', OLD_KEY],
  ]),
};

describe('github crypto', () => {
  it('round-trips token encryption', () => {
    const payload = encryptToken(KEYRING, 'gho_secret_token');
    expect(payload.split('.').slice(0, 2)).toEqual(['v1', 'current']);
    expect(decryptToken(KEYRING, payload)).toBe('gho_secret_token');
    expect(tokenNeedsRewrap(KEYRING, payload)).toBe(false);
  });

  it('rejects tampered auth tag', () => {
    const payload = encryptToken(KEYRING, 'gho_secret_token');
    const parts = payload.split('.') as [string, string, string, string, string];
    const tag = Buffer.from(parts[4], 'base64');
    const first = tag[0] ?? 0;
    tag[0] = first ^ 0xff;
    parts[4] = tag.toString('base64');
    expect(() => decryptToken(KEYRING, parts.join('.'))).toThrow();
  });

  it('decrypts an envelope written by a previous key ID', () => {
    const oldKeyring = { activeKeyId: 'old', keys: KEYRING.keys };
    const payload = encryptToken(oldKeyring, 'gho_old_token');

    expect(decryptToken(KEYRING, payload)).toBe('gho_old_token');
    expect(tokenNeedsRewrap(KEYRING, payload)).toBe(true);
  });

  it('decrypts the legacy three-part payload with any configured raw key', () => {
    const payload = legacyPayload(OLD_KEY, 'gho_legacy_token');

    expect(decryptToken(KEYRING, payload)).toBe('gho_legacy_token');
    expect(tokenNeedsRewrap(KEYRING, payload)).toBe(true);
  });

  it('rejects an envelope whose key ID is not configured', () => {
    const payload = encryptToken(KEYRING, 'gho_secret_token').replace('v1.current.', 'v1.missing.');
    expect(() => decryptToken(KEYRING, payload)).toThrow("unknown key ID 'missing'");
  });
});

function legacyPayload(key: Buffer, plaintext: string): string {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString('base64')).join('.');
}

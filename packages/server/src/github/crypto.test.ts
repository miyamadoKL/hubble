import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './crypto';

const KEY = Buffer.alloc(32, 7);

describe('github crypto', () => {
  it('round-trips token encryption', () => {
    const payload = encryptToken(KEY, 'gho_secret_token');
    expect(decryptToken(KEY, payload)).toBe('gho_secret_token');
  });

  it('rejects tampered auth tag', () => {
    const payload = encryptToken(KEY, 'gho_secret_token');
    const parts = payload.split('.') as [string, string, string];
    const tag = Buffer.from(parts[2], 'base64');
    const first = tag[0] ?? 0;
    tag[0] = first ^ 0xff;
    parts[2] = tag.toString('base64');
    expect(() => decryptToken(KEY, parts.join('.'))).toThrow();
  });
});

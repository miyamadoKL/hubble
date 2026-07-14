import { describe, expect, it } from 'vitest';
import { newId } from './id';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('接頭辞なしで小文字の RFC 4122 UUID v4 を生成する', () => {
    const id = newId();

    expect(id).toHaveLength(36);
    expect(id).toMatch(UUID_V4_PATTERN);
  });

  it('接頭辞を UUID の前へ区切りなしで連結する', () => {
    const prefix = 'wgt_';
    const id = newId(prefix);

    expect(id).toHaveLength(prefix.length + 36);
    expect(id.startsWith(prefix)).toBe(true);
    expect(id.slice(prefix.length)).toMatch(UUID_V4_PATTERN);
  });

  it('複数生成しても ID が重複しない', () => {
    const ids = Array.from({ length: 1_000 }, () => newId());

    expect(new Set(ids).size).toBe(ids.length);
  });
});

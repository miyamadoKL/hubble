import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrateLegacyStorage } from './migrateLegacyStorage';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migrateLegacyStorage', () => {
  test('copies legacy values to the new keys and removes the old ones', () => {
    localStorage.setItem('hue-fable-ui', '{"theme":"dark"}');
    localStorage.setItem('hue-fable-workspace', '["nb-1"]');
    localStorage.setItem('hue-fable-recent-contexts', '[{"catalog":"tpch"}]');
    localStorage.setItem('hue-fable-draft:nb-1', '{"name":"draft"}');

    migrateLegacyStorage();

    expect(localStorage.getItem('hubble-ui')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('hubble-workspace')).toBe('["nb-1"]');
    expect(localStorage.getItem('hubble-recent-contexts')).toBe('[{"catalog":"tpch"}]');
    expect(localStorage.getItem('hubble-draft:nb-1')).toBe('{"name":"draft"}');

    expect(localStorage.getItem('hue-fable-ui')).toBeNull();
    expect(localStorage.getItem('hue-fable-workspace')).toBeNull();
    expect(localStorage.getItem('hue-fable-recent-contexts')).toBeNull();
    expect(localStorage.getItem('hue-fable-draft:nb-1')).toBeNull();
  });

  test('does not overwrite an existing new key, but still drops the old one', () => {
    localStorage.setItem('hubble-ui', '{"theme":"light"}');
    localStorage.setItem('hue-fable-ui', '{"theme":"dark"}');
    localStorage.setItem('hubble-draft:nb-1', 'new-draft');
    localStorage.setItem('hue-fable-draft:nb-1', 'old-draft');

    migrateLegacyStorage();

    expect(localStorage.getItem('hubble-ui')).toBe('{"theme":"light"}');
    expect(localStorage.getItem('hubble-draft:nb-1')).toBe('new-draft');
    expect(localStorage.getItem('hue-fable-ui')).toBeNull();
    expect(localStorage.getItem('hue-fable-draft:nb-1')).toBeNull();
  });

  test('removes all legacy keys after migration', () => {
    localStorage.setItem('hue-fable-ui', '{"theme":"dark"}');
    localStorage.setItem('hue-fable-draft:a', 'a');
    localStorage.setItem('hue-fable-draft:b', 'b');

    migrateLegacyStorage();

    const remaining = Object.keys(localStorage).filter((k) => k.startsWith('hue-fable-'));
    expect(remaining).toEqual([]);
    expect(localStorage.getItem('hubble-draft:a')).toBe('a');
    expect(localStorage.getItem('hubble-draft:b')).toBe('b');
  });

  test('keeps the legacy value when writing the new key fails', () => {
    localStorage.setItem('hue-fable-ui', '{"theme":"dark"}');
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'hubble-ui') throw new DOMException('quota exceeded', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    });

    expect(() => migrateLegacyStorage()).not.toThrow();

    expect(localStorage.getItem('hubble-ui')).toBeNull();
    expect(localStorage.getItem('hue-fable-ui')).toBe('{"theme":"dark"}');
  });

  test('isolates getItem and removeItem failures', () => {
    localStorage.setItem('hue-fable-ui', '{"theme":"dark"}');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('access denied', 'SecurityError');
    });

    expect(() => migrateLegacyStorage()).not.toThrow();
  });

  test('does not write when checking the destination key fails', () => {
    localStorage.setItem('hue-fable-ui', '{"theme":"dark"}');
    const originalGetItem = Storage.prototype.getItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'hubble-ui') throw new DOMException('access denied', 'SecurityError');
      return originalGetItem.call(this, key);
    });

    expect(() => migrateLegacyStorage()).not.toThrow();

    expect(setItem).not.toHaveBeenCalledWith('hubble-ui', expect.any(String));
    expect(originalGetItem.call(localStorage, 'hue-fable-ui')).toBe('{"theme":"dark"}');
  });
});

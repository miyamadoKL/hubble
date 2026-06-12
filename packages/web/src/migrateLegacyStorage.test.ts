import { beforeEach, describe, expect, test } from 'vitest';
import { migrateLegacyStorage } from './migrateLegacyStorage';

beforeEach(() => {
  localStorage.clear();
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
});

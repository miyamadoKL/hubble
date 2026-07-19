import { describe, expect, test } from 'vitest';
import { t } from './t';
import type { Dictionary } from './t';

// t() の型付き翻訳と placeholder 補間を検証する。useT（React hook 版）は
// コンポーネントテスト（ScheduleBuilder 経由）で間接的にカバーされているため、
// ここでは純粋関数の t() に絞って検証する。
const dict = {
  greeting: { ja: 'こんにちは', en: 'Hello' },
  withName: { ja: '{name}さん、こんにちは', en: 'Hello, {name}' },
  withCount: { ja: '{n} 件', en: '{n} items' },
  withTwoParams: { ja: '{a}と{b}', en: '{a} and {b}' },
} as const satisfies Dictionary;

describe('t()', () => {
  test('プレースホルダーが無いキーはロケール別の文字列をそのまま返す', () => {
    expect(t(dict, 'greeting', 'ja')).toBe('こんにちは');
    expect(t(dict, 'greeting', 'en')).toBe('Hello');
  });

  test('単一のプレースホルダーを補間する', () => {
    expect(t(dict, 'withName', 'ja', { name: '田中' })).toBe('田中さん、こんにちは');
    expect(t(dict, 'withName', 'en', { name: 'Tanaka' })).toBe('Hello, Tanaka');
  });

  test('数値の補間引数も文字列化して埋め込む', () => {
    expect(t(dict, 'withCount', 'ja', { n: 3 })).toBe('3 件');
    expect(t(dict, 'withCount', 'en', { n: 3 })).toBe('3 items');
  });

  test('複数のプレースホルダーを同時に補間する', () => {
    expect(t(dict, 'withTwoParams', 'ja', { a: '月', b: '水' })).toBe('月と水');
    expect(t(dict, 'withTwoParams', 'en', { a: 'Mon', b: 'Wed' })).toBe('Mon and Wed');
  });
});

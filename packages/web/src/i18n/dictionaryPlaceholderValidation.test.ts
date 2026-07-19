/**
 * `defineDictionary` の型レベル回帰テスト: ja/en 間の placeholder 集合が一致しない
 * 辞書エントリが、意図通りコンパイルエラーになることを確認する。
 *
 * 本体の検証は型レベルで行う。`@ts-expect-error` が指す行で実際に型エラーが
 * 発生していることを `pnpm typecheck`（`tsc --noEmit`）が保証し、エラーが出ない
 * 場合はそれ自体が TS2578（Unused '@ts-expect-error' directive）としてコンパイル
 * エラーになるため、「検証が形骸化して素通りする」ことは起きない。末尾の実行時
 * テストは、このファイルを vitest と Knip の走査対象に載せるための最小のもの。
 */
import { expect, test } from 'vitest';

import { defineDictionary } from './t';

// 正常系: ja/en の placeholder 集合が完全一致していればエラーにならない。
defineDictionary({
  ok: { ja: 'こんにちは、{name}さん', en: 'Hello, {name}' },
} as const);

// 異常系1: ja 側がプレースホルダーを持たず、en 側にだけ {name} がある
// （翻訳時に ja へ補間先を入れ忘れたケース）。
defineDictionary({
  // @ts-expect-error ja is missing the {name} placeholder that en has
  missingInJa: { ja: 'こんにちは', en: 'Hello, {name}' },
} as const);

// 異常系2: ja 側にだけ余分な {name} プレースホルダーがある
// （en 側の書き換え時にプレースホルダーを消し忘れた／ja 側で誤って追加したケース）。
defineDictionary({
  // @ts-expect-error ja has an extra {name} placeholder that en does not have
  extraInJa: { ja: 'こんにちは、{name}さん', en: 'Hello' },
} as const);

// 異常系3: 双方にプレースホルダーはあるが名前が食い違っている
// （{name} vs {label} のような取り違え）。
defineDictionary({
  // @ts-expect-error ja and en use different placeholder names ({label} vs {name})
  mismatchedName: { ja: '{label}さん、こんにちは', en: 'Hello, {name}' },
} as const);

// 型レベル検証が主体のファイルを test suite として成立させるための実行時確認。
test('defineDictionary は辞書オブジェクトをそのまま返す', () => {
  const dict = defineDictionary({
    ok: { ja: 'こんにちは、{name}さん', en: 'Hello, {name}' },
  } as const);
  expect(dict.ok.en).toBe('Hello, {name}');
});

/**
 * i18n 基盤: 型付き翻訳関数。
 *
 * 辞書ファイル（`i18n/messages/*.ts`）は領域別に分割し、各エントリを
 * `{ ja: string; en: string }` の組で持つ。この型設計により、以下の 3 点が
 * typecheck の時点で検出できる:
 *   1. キーの typo: `t(dict, 'nonExistentKey', locale)` は型エラーになる
 *      （`key: keyof D` 制約）。
 *   2. 翻訳漏れ: 辞書オブジェクトを `defineDictionary({...} as const)` で定義する
 *      ため、どちらかの言語だけが定義された不完全なエントリはコンパイルエラーになる。
 *   3. ja/en 間の placeholder 集合の不一致: `defineDictionary` は各エントリの
 *      ja 側と en 側それぞれから `{name}` プレースホルダーを抽出し、集合が完全一致
 *      しないエントリの行にだけ型エラーを出す（ja 側の欠落/余剰のどちらも検出する）。
 *      回帰テストは `dictionaryPlaceholderValidation.typetest.ts` を参照。
 *
 * プレースホルダーは `{name}` 形式で辞書の文字列中に埋め込む。`en` 側の文字列から
 * テンプレートリテラル型でプレースホルダー名を抽出し、`t()` / `useT()` の呼び出しで
 * 補間引数の型（キー名と値の型）を強制する。
 */
import { useMemo } from 'react';
import { useLocale, type Locale } from './locale';

/** 辞書 1 エントリの形（日本語/英語の翻訳文字列の組）。 */
export interface MessageEntry {
  ja: string;
  en: string;
}

/** 辞書ファイルが満たすべき形。キーは翻訳識別子、値は MessageEntry。 */
export type Dictionary = Record<string, MessageEntry>;

// 文字列リテラル型から "{name}" 形式のプレースホルダー名をすべて抽出する。
type ExtractPlaceholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | ExtractPlaceholders<Rest>
  : never;

// プレースホルダーが無ければ引数なし（空タプル）、あれば「名前 → 値」のオブジェクト
// 1 個を要求するタプルにする。値は文字列と数値のどちらも許容する（件数表示等で使うため）。
type ParamsTuple<S extends string> =
  ExtractPlaceholders<S> extends never ? [] : [Record<ExtractPlaceholders<S>, string | number>];

// 2つの文字列リテラル union が集合として完全一致するかどうかを判定する
// （相互に extends し合う場合のみ true）。
type SameStringSet<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * 1つの辞書エントリについて、ja/en 双方のプレースホルダー集合が一致していれば
 * そのままの型を、一致していなければ「本来の値と絶対に代入不可能なエラー用オブジェクト
 * 型」を返す条件型。`defineDictionary` がこれを各キーに適用することで、
 * 集合が一致しないエントリの行にだけ型エラーを局所的に出せる
 * （どちらのプレースホルダーが余分/不足かをエラーメッセージのプロパティ名で示す）。
 */
type ValidatedEntry<E extends MessageEntry> =
  SameStringSet<ExtractPlaceholders<E['ja']>, ExtractPlaceholders<E['en']>> extends true
    ? E
    : {
        placeholderMismatchBetweenJaAndEn: true;
        jaPlaceholders: ExtractPlaceholders<E['ja']>;
        enPlaceholders: ExtractPlaceholders<E['en']>;
      };

/** 辞書オブジェクト全体に `ValidatedEntry` を適用するマップ型。 */
type ValidatedDictionary<D extends Dictionary> = { [K in keyof D]: ValidatedEntry<D[K]> };

/**
 * 辞書オブジェクトを定義するためのアイデンティティ関数。実行時には引数をそのまま
 * 返すだけだが、型パラメータ `D` が呼び出し引数の型として自己参照的に推論される
 * ことを利用し、`D & ValidatedDictionary<D>` という交差型で「各エントリの ja/en の
 * プレースホルダー集合が一致していること」を制約として課す。一致しないエントリが
 * あると、そのキーの行にだけ型エラーが出る（辞書全体が丸ごとエラーにはならない）。
 *
 * 各辞書ファイルは `export const xxx = defineDictionary({ ... } as const);` の形で使う
 * （直接 `as const satisfies Dictionary` を書くとこの検証を経由しない）。
 */
export function defineDictionary<D extends Dictionary>(dict: D & ValidatedDictionary<D>): D {
  return dict;
}

/**
 * 辞書からキーを引いて、指定ロケールの文字列にプレースホルダーを補間して返す。
 *
 * @param dict 領域別の辞書オブジェクト（`i18n/messages/*.ts` からインポートする）。
 * @param key 辞書内のキー。存在しないキーは型エラーになる。
 * @param locale 現在のロケール。
 * @param args プレースホルダーを含む場合のみ、`{name: value}` 形式の補間引数を渡す。
 */
export function t<D extends Dictionary, K extends keyof D>(
  dict: D,
  key: K,
  locale: Locale,
  ...args: ParamsTuple<D[K]['en']>
): string {
  const entry = dict[key] as MessageEntry;
  const template = entry[locale];
  const params = args[0] as Record<string, string | number> | undefined;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** `useT` が返す翻訳関数の型。辞書 D に紐づいたキー/補間引数の型を保つ。 */
export type TFn<D extends Dictionary> = <K extends keyof D>(
  key: K,
  ...args: ParamsTuple<D[K]['en']>
) => string;

/**
 * コンポーネント内で使う、現在のロケールに束縛された翻訳関数を返すフック。
 * ロケールが変わるたびに新しい関数を返す（呼び出し側での再レンダーを保証する）。
 *
 * @param dict 領域別の辞書オブジェクト。
 */
export function useT<D extends Dictionary>(dict: D): TFn<D> {
  const { locale } = useLocale();
  return useMemo<TFn<D>>(() => {
    const fn = ((key: keyof D, ...args: ParamsTuple<D[keyof D]['en']>) =>
      t(dict, key, locale, ...args)) as TFn<D>;
    return fn;
  }, [dict, locale]);
}

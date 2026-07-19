/**
 * i18n 基盤: 現在のロケール（言語）を管理する React Context。
 *
 * なぜ i18next のような汎用ライブラリを使わないか: Hubble の対応言語は日本語/英語の
 * 2 つに固定されており、複数形処理、名前空間分割、翻訳ファイルの遅延ロードといった
 * 汎用ライブラリが提供する機能は不要である。`t.ts` の型付き辞書（as const + keyof）
 * だけで「キーの typo」と「翻訳漏れ」を typecheck の時点で検出でき、ライブラリ依存を
 * 追加しないことで bundle サイズの増加もゼロに抑えられる。
 *
 * 初期値の決定順序:
 *   1. localStorage に保存済みの値（`hubble-locale:<scope>`。scope は認証主体ごとの
 *      namespace で、命名規則は `storage/principalStorage.ts` の既存キー（例:
 *      `hubble-ui:<scope>`）に合わせている）
 *   2. どちらにも該当しなければ navigator.language が日本語系（ja, ja-JP 等）なら ja、
 *      それ以外は en
 *
 * Provider の外側（LocaleProvider を経由しない単体テスト等）で `useLocale()` が
 * 呼ばれた場合は、英語をデフォルトとして返す（例外は投げない）。これは既存の
 * コンポーネントテストの多くが Provider でラップせずにコンポーネントを直接
 * マウントしているため、Provider 必須にすると大量のテストが壊れてしまうことへの
 * 実務上の配慮である。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { principalStorageKey } from '../storage/principalStorage';

/** アプリが対応する言語コード。 */
export type Locale = 'ja' | 'en';

/** localStorage キーのベース名（principalStorageKey で認証主体ごとの scope を付与する）。 */
const STORAGE_BASE = 'hubble-locale';

/**
 * 保存済みロケールを localStorage から読み出す。principalStorage がまだ有効化されて
 * いない（認証前）場合や、localStorage が使えない環境（プライベートモード等）では
 * 例外を握りつぶして null を返す。
 */
function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(principalStorageKey(STORAGE_BASE));
    return stored === 'ja' || stored === 'en' ? stored : null;
  } catch {
    return null;
  }
}

/** navigator.language から初期ロケールを推定する。日本語系のみ ja、それ以外は en。 */
function detectNavigatorLocale(): Locale {
  const lang = typeof navigator !== 'undefined' ? navigator.language : '';
  return lang.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** localStorage → navigator.language の優先順位で初期ロケールを決定する。 */
function detectInitialLocale(): Locale {
  return readStoredLocale() ?? detectNavigatorLocale();
}

interface LocaleContextValue {
  /** 現在のロケール。 */
  locale: Locale;
  /** ロケールを切り替える。即座に反映し、localStorage にも永続化する。 */
  setLocale: (locale: Locale) => void;
}

// Provider の外側で使われた場合のデフォルト値。英語をフォールバックにする
// （多くの単体テストが Provider なしでコンポーネントを直接マウントしているため）。
const defaultContextValue: LocaleContextValue = {
  locale: 'en',
  setLocale: () => {
    /* Provider の外側では何もしない */
  },
};

const LocaleContext = createContext<LocaleContextValue>(defaultContextValue);

/**
 * アプリ全体にロケール状態を配線する Provider。`AppShell` のルートで一度だけ使う。
 * ロケールが変わるたびに `<html lang>` 属性も更新し、支援技術（スクリーンリーダー等）
 * が正しい言語で読み上げられるようにする。
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(principalStorageKey(STORAGE_BASE), next);
    } catch {
      /* localStorage が使えない環境では永続化を諦め、当該セッション内の切替のみ有効にする */
    }
  };

  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale }), [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** 現在のロケールと切替関数を取得する。Provider の外側では英語がデフォルトになる。 */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

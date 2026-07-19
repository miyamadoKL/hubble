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
 *
 * principal storage 有効化前後の2段階初期化について（レビュー指摘対応）:
 * `LocaleProvider` は `AuthGate` より外側（`App.tsx`）にマウントされるため、
 * mount 時点で走る `detectInitialLocale()` はまだ `activatePrincipalStorage`
 * （`AuthGate.tsx` の effect 内）が呼ばれておらず、`principalStorageKey()` が
 * 例外を投げて保存済みロケールを読めない（`readStoredLocale` が握りつぶして
 * null を返し、navigator.language 判定にフォールバックする）。このため、保存済み
 * ロケールが常に反映されるとは限らない。`useHydrateLocaleFromPrincipalStorage`
 * フックを `AuthGate` 側から principal storage 有効化完了のタイミングで呼び出し、
 * 保存済み値を読み直して反映させることでこれを解消する。
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
 * 例外を握りつぶして null を返す。principal storage 有効化後の再読み込み
 * （`useHydrateLocaleFromPrincipalStorage`）からも共有して使う。
 */
export function readStoredLocale(): Locale | null {
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
 * アプリ全体にロケール状態を配線する Provider。`App`（`App.tsx`）のルートで
 * 一度だけ使う。認証要求画面（`AuthRequired`）は `AppShell` より前段（`AuthGate`
 * の内側）で描画されるため、`AppShell` の内側ではなく `AuthGate` より外側に置く
 * 必要がある（Phase 2b で `AppShell` から `App` へ配線位置を移動した）。
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

/**
 * principal storage が有効化された時点（`ready` が false → true に変わった瞬間）で
 * 一度だけ、保存済みロケールを読み直して反映するフック。`AuthGate` から、
 * principal storage の有効化が完了したかどうか（`readyIdentity` の確定条件と同じ
 * 判定）を渡して呼び出す。
 *
 * `LocaleProvider` の初期化（`detectInitialLocale`）は principal storage 有効化前に
 * 走るため、保存済みロケールを読めず navigator.language 判定にフォールバックした
 * ままになる（このファイル冒頭のコメント参照）。有効化完了後に改めて
 * `readStoredLocale()` を呼び直すことで、その取りこぼしを解消する。
 *
 * @param ready principal storage の有効化が完了しているかどうか。
 */
export function useHydrateLocaleFromPrincipalStorage(ready: boolean): void {
  const { setLocale } = useLocale();
  useEffect(() => {
    if (!ready) return;
    const stored = readStoredLocale();
    if (stored) setLocale(stored);
    // setLocale は使うが依存配列には含めない: LocaleProvider は locale が変わるたびに
    // 新しい setLocale を生成するため、含めると「有効化後にユーザーが手動でロケールを
    // 切り替えるたびにこの effect が再実行される」（実害はないが無駄な再読み込みが
    // 走る）ことになる。ここでは「有効化完了時に1回だけ」の実行を優先する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}

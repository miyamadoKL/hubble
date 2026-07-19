/**
 * アプリケーションのルートコンポーネント定義ファイル。
 * Hubble SQL Workbench の画面全体を組み立てる最上位のコンポーネント `App` を
 * ここで定義する。認証状態のチェック（AuthGate）とメインのアプリシェル
 * （AppShell）を組み合わせるだけの薄いラッパーであり、
 * ルーティングや複雑なレイアウトロジックは各コンポーネント側に委譲している。
 */
import { lazy, Suspense } from 'react';
// 認証状態に応じて子要素の表示/非表示を切り替えるゲートコンポーネント。
import { AuthGate } from './components/auth/AuthGate';
import { LocaleProvider } from './i18n/locale';
import { useT } from './i18n/t';
import { layoutMessages } from './i18n/messages/layout';

// notebook機能に残るANTLR利用も初期HTMLのimport graphから分離する。
const AppShell = lazy(() =>
  import('./components/layout/AppShell').then((module) => ({ default: module.AppShell })),
);

/**
 * AppShell の遅延読み込み中に表示するフォールバック。
 * `LocaleProvider` のサブツリー内（App の子孫）で描画される必要があるため、
 * `App` 本体とは別コンポーネントに切り出している（`App` 自身は `LocaleProvider`
 * を配線する側であり、自分自身の中では自分が配線した Context を消費できないため）。
 */
function LoadingWorkspaceFallback() {
  const t = useT(layoutMessages);
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base text-sm text-ink-muted">
      {t('loadingWorkspace')}
    </div>
  );
}

/**
 * アプリケーションのルートコンポーネント。
 * `AuthGate` で `AppShell` 全体をラップすることで、
 * プロキシ経由の未認証セッションの場合は「認証が必要」という画面に
 * 差し替えて表示する。認証モードが `none`（認証不要）の場合、
 * `AuthGate` は何もせずに子要素（`AppShell`）をそのまま透過的に表示する。
 *
 * `LocaleProvider` は `AuthGate` より外側でここに一度だけ配線する。認証要求画面
 * （`AuthRequired`）は `AppShell` より前段で描画されるため、`AppShell` の内側に
 * Provider を置くと認証前の画面がロケール切替の対象外になってしまう。
 */
export default function App() {
  return (
    <LocaleProvider>
      {/* 認証チェックを行うゲート。未認証時はここで AppShell の代わりに
        認証要求画面がレンダリングされる。 */}
      <AuthGate>
        {/* サイドバー、エディタ、結果パネルなどアプリ本体のレイアウト */}
        <Suspense fallback={<LoadingWorkspaceFallback />}>
          <AppShell />
        </Suspense>
      </AuthGate>
    </LocaleProvider>
  );
}

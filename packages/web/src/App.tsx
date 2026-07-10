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

// notebook機能に残るANTLR利用も初期HTMLのimport graphから分離する。
const AppShell = lazy(() =>
  import('./components/layout/AppShell').then((module) => ({ default: module.AppShell })),
);

/**
 * Hubble SQL Workbench — application root. `AuthGate` wraps
 * the shell so an unauthenticated proxy session swaps the UI for the
 * "authentication required" screen; in `none` mode the gate is transparent.
 *
 * アプリケーションのルートコンポーネント。
 * `AuthGate` で `AppShell` 全体をラップすることで、
 * プロキシ経由の未認証セッションの場合は「認証が必要」という画面に
 * 差し替えて表示する。認証モードが `none`（認証不要）の場合、
 * `AuthGate` は何もせずに子要素（`AppShell`）をそのまま透過的に表示する。
 */
export default function App() {
  return (
    // 認証チェックを行うゲート。未認証時はここで AppShell の代わりに
    // 認証要求画面がレンダリングされる。
    <AuthGate>
      {/* サイドバー、エディタ、結果パネルなどアプリ本体のレイアウト */}
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center bg-surface-base text-sm text-ink-muted">
            Loading workspace…
          </div>
        }
      >
        <AppShell />
      </Suspense>
    </AuthGate>
  );
}

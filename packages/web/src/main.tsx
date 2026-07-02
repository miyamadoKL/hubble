/**
 * Hubble Web アプリケーションのエントリポイント。
 * ブラウザ上で React アプリを DOM にマウントし、React Query の
 * QueryClientProvider や StrictMode などのグローバルなラッパーをここで設定する。
 * このファイルが最初に読み込まれるモジュールであるため、
 * 他のどのストアよりも先に実行しておく必要がある処理（localStorage の
 * キー移行など）もここでインポート順により制御している。
 */

// Imported first: runs the one-time hue-fable-* -> hubble-* localStorage rename
// before any store reads the new keys (see migrateLegacyStorage.ts).
// 最初にインポートすることで、他のストア（zustand の persist など）が
// 'hubble-*' キーを読み取る前に、旧 'hue-fable-*' キーからの
// 一度きりのリネーム移行処理を完了させる。
import './migrateLegacyStorage';
// React 18 の StrictMode。開発時に副作用の二重実行などを検出し、
// 潜在的なバグを早期に発見しやすくするためのラッパーコンポーネント。
import { StrictMode } from 'react';
// React 18 の新しいルートAPI。DOM 要素に React ツリーをマウントするために使用する。
import { createRoot } from 'react-dom/client';
// TanStack Query（React Query）のクライアントとプロバイダー。
// サーバーから取得したデータのキャッシュ、再取得、状態管理を担う。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// アプリ全体のテーマ用 CSS（デザイントークン、ライト/ダークテーマなど）を読み込む。
import './theme/theme.css';
// アプリケーションのルートコンポーネント（ルーティングとレイアウトの起点）。
import App from './App';

// アプリ全体で共有する単一の QueryClient インスタンスを生成する。
// これによりコンポーネント間でクエリキャッシュが共有される。
const queryClient = new QueryClient();

// index.html 側で用意されている #root 要素を取得する。
// この要素が React ツリーのマウント先になる。
const rootElement = document.getElementById('root');
if (!rootElement) {
  // #root が存在しない場合は致命的なエラーとして即座に例外を投げる。
  // HTML テンプレートが壊れている等、アプリが起動できない状態を示す。
  throw new Error('Root element #root not found');
}

// #root 要素に React アプリケーションをレンダリングする。
// StrictMode で開発時チェックを有効化しつつ、
// QueryClientProvider でアプリ全体に React Query のクライアントを供給する。
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

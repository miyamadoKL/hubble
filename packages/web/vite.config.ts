import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * web パッケージ（React SPA）の Vite 設定ファイル。
 * React 用プラグインと Tailwind CSS 用プラグインを有効化しつつ、
 * バンドルサイズ最適化のためのチャンク分割設定と、開発時に BFF server へ
 * `/api` リクエストをプロキシする設定を行う。
 */
export default defineConfig({
  // React（JSX 変換や Fast Refresh）と Tailwind CSS を有効化する。
  plugins: [react(), tailwindcss()],
  // Monaco + the ANTLR grammar + ECharts are large; isolate them into their own
  // chunks so the initial app payload stays small (design.md §8 "チャンク分離").
  // The editor and charts are loaded via dynamic import, so these only download
  // when a cell renders / a chart tab is opened.
  // Monaco エディタ、ANTLR 由来の文法定義、ECharts はいずれもサイズが大きいため、
  // それぞれ専用のチャンクに分離し、アプリ初回読み込み時のペイロードを
  // 小さく保つ（design.md §8 の「チャンク分離」）。エディタとチャート機能は
  // 動的 import で読み込まれるため、これらのチャンクはセルが描画されたときや
  // チャートタブが開かれたときにのみダウンロードされる。
  build: {
    rollupOptions: {
      output: {
        // モジュール id のパスを見て、該当するチャンク名を返す振り分け関数。
        manualChunks(id) {
          // Monaco エディタ本体を専用チャンクに分離。
          if (id.includes('monaco-editor')) return 'monaco';
          // ANTLR から自動生成された Trino SQL 文法定義を専用チャンクに分離。
          if (id.includes('/trino-lang/generated/')) return 'trino-grammar';
          // ANTLR ランタイム（antlr4ng / antlr4-c3）を専用チャンクに分離。
          if (id.includes('antlr4ng') || id.includes('antlr4-c3')) return 'antlr';
          // チャート描画ライブラリ（ECharts / zrender）を専用チャンクに分離。
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts';
          // 上記のいずれにも該当しない場合は Vite の既定のチャンク分割に任せる。
          return undefined;
        },
      },
    },
  },
  // Web Worker のビルド形式を ES モジュールに指定する。
  worker: {
    format: 'es',
  },
  server: {
    // 開発サーバーのポート番号。
    port: 5173,
    proxy: {
      '/api': {
        // Follow the BFF port: default 8080, overridden by PORT (e.g. when a
        // sourced .env moves the server to avoid a local port clash).
        // BFF server のポートに追従する。既定値は 8080 だが、環境変数 PORT で
        // 上書きされる（例えば .env の読み込みでローカルのポート衝突を避けるために
        // server 側のポートを変更した場合など）。
        target: `http://localhost:${process.env.PORT ?? 8080}`,
        // Origin ヘッダーをプロキシ先に合わせて書き換える。
        changeOrigin: true,
      },
    },
  },
});

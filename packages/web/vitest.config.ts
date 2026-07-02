import { defineConfig } from 'vitest/config';

/**
 * web パッケージ（React SPA）の Vitest 設定ファイル。
 * ブラウザ DOM を模した jsdom 環境でユニットテストを実行する。
 */
export default defineConfig({
  test: {
    // DOM API（document, window など）を模した jsdom 環境でテストを実行する。
    environment: 'jsdom',
    // テスト対象ファイルのパターン（src 配下の *.test.ts / *.test.tsx）。
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The ANTLR-backed language layer runs synchronously with no worker, so the
    // analyzer/splitter/completion tests need no special setup.
    // ANTLR ベースの言語解析レイヤーは Worker を使わず同期的に動作するため、
    // アナライザ、分割、補完まわりのテストに特別なセットアップは不要。
    // `describe`/`it` などのグローバル関数は自動注入せず、明示的な import を要求する。
    globals: false,
  },
});

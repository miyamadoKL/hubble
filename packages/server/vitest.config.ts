import { defineConfig } from 'vitest/config';

/**
 * server パッケージの Vitest 設定。
 *
 * PostgreSQL のテストは `src/test/dbBackends.ts` が workerごとに schema を分け、
 * 同一 worker 内のケースだけを TRUNCATE で初期化する。migration のglobal advisory
 * lockは既存の安全性を保つため維持し、PostgreSQL 使用時もファイル並列を有効にする。
 */
export default defineConfig({
  test: {
    // 過去 build の ignored dist が残っていても、生成済み test を重複実行しない。
    include: ['src/**/*.test.ts'],
    fileParallelism: true,
  },
});

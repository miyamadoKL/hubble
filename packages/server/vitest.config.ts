import { defineConfig } from 'vitest/config';

/**
 * server パッケージの Vitest 設定。
 *
 * PostgreSQL バックエンドのテストは単一の共有 DB を `TRUNCATE` で分離する
 * (`src/test/dbBackends.ts`)。Vitest がテストファイルを並列実行すると、別ファイルの
 * TRUNCATE が実行中のファイルの行をテスト途中で消し、owner スコープの検証が
 * 非決定的に失敗する。そこで共有 postgres バックエンドが有効なとき
 * (`TEST_DATABASE_URL` 設定時、主に CI)はファイル並列を無効化して直列実行する。
 * SQLite のみのローカル実行はファイルごとに新規のインメモリ DB を開くため、
 * 並列のままで衝突しない。
 */
export default defineConfig({
  test: {
    fileParallelism: process.env.TEST_DATABASE_URL ? false : true,
  },
});

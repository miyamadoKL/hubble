// @ts-check
//
// Hubble モノレポ全体の ESLint フラット設定ファイル。
// server（Node）/ contracts（isomorphic）/ web（ブラウザ + React）といった
// パッケージごとに異なる実行環境とルールセットを、`files` パターンで
// 対象を絞り込みながら重ね合わせる形で定義している。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Lint 対象から除外するパス（ビルド成果物、依存関係、設定ファイルなど）。
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.config.js',
      '**/*.config.ts',
      // Agent infrastructure, not part of the app (gitignored).
      // エージェント関連のインフラ用ディレクトリ。アプリ本体ではない（gitignore 対象）。
      '.opencode/**',
      // Machine-generated ANTLR output (derived from the Trino grammar). Excluded
      // from lint; it still typechecks via @ts-nocheck. Regenerate with
      // `pnpm --filter @hubble/web gen:grammar`.
      // ANTLR による自動生成コード（Trino の文法定義から生成）。lint 対象外だが
      // @ts-nocheck 付きで型チェックは通る。再生成コマンド:
      // `pnpm --filter @hubble/web gen:grammar`。
      'packages/web/src/trino-lang/generated/**',
    ],
  },
  // ESLint 標準の推奨ルールセット。
  js.configs.recommended,
  // typescript-eslint の推奨ルールセット一式。
  ...tseslint.configs.recommended,
  // Server / Node packages and repo scripts
  // server パッケージや e2e、リポジトリ直下のスクリプト類は Node.js 環境で動くため
  // Node 用のグローバル変数（process, __dirname など）を許可する。
  {
    files: [
      'packages/server/**/*.ts',
      'e2e/**/*.{ts,mjs}',
      'scripts/**/*.mjs',
      'packages/web/scripts/**/*.mjs',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Contracts (isomorphic)
  // contracts パッケージは server / web の両方から読み込まれる等方的なコードなので、
  // 便宜上 Node のグローバルを許可しておく（実際にはブラウザ環境グローバルには依存しない）。
  {
    files: ['packages/contracts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Web (browser + React)
  // web パッケージはブラウザ環境で動作する React アプリなので、ブラウザの
  // グローバル変数（window, document など）を許可し、react-hooks の
  // 推奨ルール（Hooks の呼び出し順序や依存配列チェックなど）を適用する。
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  // trino-lang fork: ANTLR/antlr4ng impose listener signatures whose params are
  // often unused. Allow the conventional `_`-prefix to mark them intentionally.
  // trino-lang（ANTLR/antlr4ng ベースの SQL パーサー移植コード）は、
  // リスナーのシグネチャ上、実際には使わない引数を持つことが多い。
  // 慣例的な `_` プレフィックスを付けた引数と変数は「意図的に未使用」として許可する。
  {
    files: ['packages/web/src/trino-lang/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Test files may use more relaxed rules
  // テストファイルはモックなどで `any` を使うことが多いため、
  // no-explicit-any ルールを無効化して緩めたルールセットにする。
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Prettier と競合する整形系ルールを無効化する（整形は Prettier に一任する）。
  prettier,
);

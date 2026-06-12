// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
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
      '.opencode/**',
      // Machine-generated ANTLR output (derived from the Trino grammar). Excluded
      // from lint; it still typechecks via @ts-nocheck. Regenerate with
      // `pnpm --filter @hubble/web gen:grammar`.
      'packages/web/src/trino-lang/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Server / Node packages and repo scripts
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
  {
    files: ['packages/contracts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Web (browser + React)
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
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);

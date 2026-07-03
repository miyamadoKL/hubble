# AGENTS.md

Cursor / Codex 系コーディングエージェント向けの規約。既存プロジェクトルールの転記であり、新しいルールはここで発明しない。

## コメント

- 新規・変更コードのコメントは日本語（ファイルヘッダー、export への JSDoc、自明でないロジックの行コメント）
- 既存コメントは英語を含め削除しない
- 日本語文中で em ダッシュ(—)と並列の中黒(・)を使わない
- 「重要なのは」「非常に」「包括的」などの空虚な表現を使わない

## ファイル

- すべてのファイルに EOF の末尾改行を入れる
- `packages/web/src/trino-lang/generated/`（ANTLR 生成物）にはコメント追加も編集もしない

## テスト

- 依存注入でフェイク化した外部ドライバ（pg、mysql2 など）には、実モジュールを import して動かすテストを最低 1 件残す
- 理由: フェイクでは ESM/CJS の import 不整合を検出できない

## 検証

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

## コミット

英語の [Conventional Commits](https://www.conventionalcommits.org/) 形式を使う。

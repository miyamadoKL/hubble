# Hubble SQL Workbench

**日本語** | [English](README_en.md)

[cloudera/hue](https://github.com/cloudera/hue) の **Notebook** 体験 — 複数セル、
セルごとの実行と結果表示、変数の置換、スキーマブラウジング、履歴、チャート — を
保ちつつ、モダンで単一言語の TypeScript アプリとして作り直した、Trino 特化の
クエリエディターです。

![Hubble SQL Workbench — ライトテーマ、JOIN の結果をグリッドに表示](docs/screenshots/final-light.png)

| ダークテーマ                                     | GROUP BY → 棒グラフ                                 |
| ------------------------------------------------ | --------------------------------------------------- |
| ![ダークテーマ](docs/screenshots/final-dark.png) | ![結果の棒グラフ](docs/screenshots/final-chart.png) |

| 変数 + 実行                                                                             |
| --------------------------------------------------------------------------------------- |
| ![パラメーター化されたクエリを駆動する変数パネル](docs/screenshots/final-variables.png) |

> 設計上 Trino 専用です。認証、複数エンジン対応、Hue のドキュメント共有 /
> スケジューリングは、v1 では明確に対象外（non-goal）としています（`docs/design.md` を参照）。

## 主な機能

- **Notebook モデル** — SQL + Markdown セル、ドラッグによる並べ替え、セルごとの実行、
  全実行、選択範囲 / キャレット位置のステートメント実行、キャンセル、進捗のライブ表示。
- **Monaco エディター**（Trino 文法、ANTLR）: シンタックスハイライト、スキーマを
  考慮した補完（FQN + カラム + CTE）、ホバー、リアルタイムのエラーマーカー、整形。
- **ライブ結果** — 仮想化グリッド（固定ヘッダ、28px 行）、カラムの表示 / 非表示 +
  検索、クライアントサイドのフィルタ / ソート、CSV ダウンロード（gzip は任意）、
  TSV / HTML でのコピー。
- **チャート**（ECharts） — 棒 / 折れ線 / タイムライン / 円 / 散布図。X/Y（複数 Y）、
  ソート、行数上限、散布図のグループ / サイズの各コントロールに対応。テーマとパレットは
  design token から導出されるため、チャートもライト / ダークの切り替えに追従します。
- **変数** — `${name}` / `${name=default}` / `${name=a,b}` / `${name=label(value)}`。
  型を推論した入力欄、コメントを考慮した置換、実行時に解決されます。
- **アシストサイドバー** — カタログ → スキーマ → テーブル → カラムのツリー（遅延読み込み）、
  サンプル行付きのテーブル詳細ポップオーバー、notebook / saved-query / 履歴の各パネル。
- **コマンドパレット**（Ctrl/Cmd+K）、充実したキーボードショートカット、そして SQL を
  `--` 見出しでカードに分割する読み取り専用の**プレゼンテーションモード**。
- **Query Guard** — 実行前に `EXPLAIN (TYPE IO)` でスキャン量を推定し、管理者設定の上限を超えるクエリを警告またはブロック。Trino に不慣れなユーザーによる巨大クエリを防ぎます。

## アーキテクチャ

pnpm workspace の monorepo で、全体を TypeScript で記述しています。

```
packages/
  contracts/   # zod schemas + types — the API/type contract; server & web depend on it
  server/      # Hono BFF: Trino /v1/statement proxy, SSE, CSV stream, SQLite persistence
  web/         # React 19 + Vite + Tailwind v4; Monaco editor; ECharts; zustand + TanStack Query
e2e/           # Playwright E2E suites (editor / execution / results / notebook / panels / chart / app) against a live Trino (tpch)
```

- **コントラクトファースト**: `packages/contracts` の zod 定義が正本（source of truth）で、
  server と web はその周りに位置する再生成可能な実装層です。
- **状態管理**: zustand のストア（`ui`、`notebook`、`execution`、チャート設定）+ サーバー
  状態は TanStack Query。コンポーネントはプレゼンテーションに徹します。
- **結果はメモリ上に保持**: 行データは server のメモリ + SSE に存在し、SQLite には
  サマリ（notebooks、saved queries、history、セルごとの `resultMeta`）のみを永続化します。
- **design token はコントラクト**: 色 / 余白 / タイポグラフィはすべて
  `packages/web/src/theme/tokens.css` に置かれ、コンポーネント内での生 hex は ast-grep の
  lint ルールでブロックされます。Monaco と ECharts のテーマは実行時に `getComputedStyle`
  経由でこれらの token から導出されるため、どちらもテーマ切り替えに追従します。

設計・データモデル・API コントラクトの全体は `docs/design.md` を参照してください。

## はじめに

前提: **Node 24 以上**、**pnpm 11**、そして到達可能な **Trino**（e2e スイートと
スクリーンショットは `tpch` カタログを前提とします。例: `:30080` で動くローカル Trino）。

```bash
pnpm install

# Terminal 1 — the BFF (Hono) on :8080
PORT=8080 TRINO_BASE_URL=http://localhost:30080 \
  pnpm --filter @hubble/server dev

# Terminal 2 — the web app (Vite) on :5173, proxying /api → :8080
pnpm --filter @hubble/web dev
```

そのうえで <http://localhost:5173> を開きます。（`pnpm dev` で両方を並行起動できます。）

### 環境変数（server）

| 変数                              | 既定値                   | 説明                                                                                            |
| --------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `PORT`                            | `8080`                   | BFF が待ち受ける HTTP ポート                                                                    |
| `DB_PATH`                         | `./data/hubble.db`       | SQLite データベースファイル                                                                     |
| `DATABASE_URL`                    | —                        | `postgres://` 形式の接続文字列。設定すると永続化が PostgreSQL になり `DB_PATH` より優先         |
| `STATIC_DIR`                      | —                        | ビルド済み web アプリのディレクトリ（例 `packages/web/dist`）。配信 + SPA フォールバックを担う  |
| `TRINO_BASE_URL`                  | `http://127.0.0.1:30080` | Trino コーディネーターのベース URL                                                              |
| `TRINO_USER`                      | `admin`                  | `X-Trino-User` として送る値                                                                     |
| `TRINO_USERNAME`                  | `admin`                  | Basic 認証のユーザー名                                                                          |
| `TRINO_PASSWORD`                  | ``（空）                 | Basic 認証のパスワード                                                                          |
| `TRINO_SOURCE`                    | `hubble`                 | ユーザークエリ向けの `X-Trino-Source`                                                           |
| `TRINO_METADATA_SOURCE`           | `hubble-metadata`        | メタデータクエリ向けの `X-Trino-Source`                                                         |
| `DEFAULT_CATALOG`                 | —                        | 新規 notebook の初期カタログ                                                                    |
| `DEFAULT_SCHEMA`                  | —                        | 新規 notebook の初期スキーマ                                                                    |
| `DEFAULT_LIMIT`                   | `5000`                   | `LIMIT` のない `SELECT` に自動付与する `LIMIT`                                                  |
| `QUERY_MAX_ROWS`                  | `100000`                 | クエリごとに server 側でバッファする行数の上限                                                  |
| `QUERY_CONCURRENCY`               | `5`                      | 同時に追跡するクエリ数の上限                                                                    |
| `QUERY_TTL_MINUTES`               | `30`                     | 完了したクエリを掃除するまでの保持時間                                                          |
| `QUERY_OVERFLOW_MODE`             | `truncate`               | `QUERY_MAX_ROWS` 超過時の挙動（`truncate` または `cancel`）                                     |
| `METADATA_TTL_SECONDS`            | `300`                    | メタデータキャッシュの TTL                                                                      |
| `APP_VERSION`                     | `0.1.0`                  | `GET /api/config` が返すバージョン                                                              |
| `QUERY_GUARD_MODE`                | `warn`                   | Query Guard モード（`off`=無効 / `warn`=推定表示のみ / `enforce`=上限超過時に HTTP 422 で拒否） |
| `QUERY_GUARD_MAX_SCAN_BYTES`      | `0`（無制限）            | スキャンバイト数の上限（0 = 無制限）                                                            |
| `QUERY_GUARD_MAX_SCAN_ROWS`       | `0`（無制限）            | スキャン行数の上限（0 = 無制限）                                                                |
| `QUERY_GUARD_ON_UNKNOWN`          | `warn`                   | 統計が無く推定不能なときの扱い（`allow` / `warn` / `block`）                                    |
| `QUERY_GUARD_ESTIMATE_TIMEOUT_MS` | `3000`                   | EXPLAIN のタイムアウト（ミリ秒）                                                                |
| `QUERY_GUARD_CACHE_TTL_SECONDS`   | `30`                     | 推定結果キャッシュの TTL（秒）                                                                  |
| `QUERY_GUARD_BYTES_PER_SECOND`    | `0`（目安なし）          | クラスタースループット目安（バイト/秒）。0 より大きい値を設定すると UI に所要時間の目安を表示   |

## ドキュメント

- **[利用ガイド](docs/user-guide.md)** — 分析者向け: UI、クエリの実行、notebook、変数、結果、チャート、ダウンロード / コピー、ショートカット。
- **[運用ガイド](docs/operations.md)** — 運用者向け: `STATIC_DIR` を使った単一プロセスのデプロイ、環境変数、oauth2-proxy + Trino の impersonation / resource group、バックアップ、チューニング。
- **[デプロイガイド](docs/deployment.md)** — 運用者向け: Docker イメージ、Docker Compose（デモ用 Trino 付き）、Kubernetes（kustomize）でのデプロイ。

## 品質ゲート

```bash
pnpm typecheck   # tsc across contracts / server / web / e2e
pnpm lint        # eslint + ast-grep (no raw hex, etc.)
pnpm test        # vitest across contracts / server / web
pnpm --filter web build

# End-to-end against a live Trino (tpch). Starts the server (in-memory DB) + web
# automatically; needs a reachable Trino on :30080.
pnpm --filter @hubble/e2e test
```

E2E スイート（editor / execution / results / notebook / panels / chart / app にわたる
35 テスト）は、決定的な `tpch.tiny` / `tpch.sf1` データを持つ本物の Trino に対して実行
します。インメモリの SQLite（`DB_PATH=:memory:`）を使うため自分の notebook には一切
触れず、`QUERY_MAX_ROWS=10000` で truncation の経路を確認します。v1 チェックリストの
各項目に対する受け入れ監査は
[`docs/acceptance-v1.md`](docs/acceptance-v1.md) にあります。

## キーボードショートカット

| 操作                               | ショートカット                      |
| ---------------------------------- | ----------------------------------- |
| アクティブセルを実行               | Ctrl/Cmd + Enter                    |
| Notebook を保存                    | Ctrl/Cmd + S                        |
| SQL を整形                         | Ctrl/Cmd + I · Ctrl/Cmd + Shift + F |
| コマンドパレット                   | Ctrl/Cmd + K                        |
| ライト / ダークテーマの切り替え    | Ctrl + Alt + T                      |
| プレゼンテーションモードの切り替え | Ctrl/Cmd + Shift + P                |

（コマンドパレット → 「Keyboard shortcuts」からも利用できます。）

## ライセンス

`packages/web/src/trino-lang/` 配下の Trino SQL 文法と ANTLR 生成の
lexer/parser は [Trino](https://github.com/trinodb/trino) プロジェクト由来であり、
**Apache-2.0** ライセンスです。これらのファイルはインラインの来歴コメントを伴います。
完全な帰属表示は [`NOTICE`](NOTICE) にあります。

名称とロゴ（「Hubble」）はオリジナルです。Hue、Cloudera、Trino の商標およびロゴは
使用していません。

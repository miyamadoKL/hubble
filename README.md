# Hubble SQL Workbench

**日本語** | [English](README_en.md)

[cloudera/hue](https://github.com/cloudera/hue) の **Notebook** 体験を保ちつつ、
モダンな単一言語 TypeScript アプリとして作り直した、Trino、MySQL、PostgreSQL
対応の SQL ワークベンチです。複数セル、セルごとの実行と結果表示、変数の置換、
スキーマブラウジング、履歴、チャートといった Notebook の操作はそのままです。
SQL 補完 (ANTLR) と Query Guard の事前見積りは Trino のみ対応です。

![Hubble SQL Workbench — ライトテーマ、JOIN の結果をグリッドに表示](docs/screenshots/final-light.png)

| ダークテーマ                                     | GROUP BY → 棒グラフ                                 |
| ------------------------------------------------ | --------------------------------------------------- |
| ![ダークテーマ](docs/screenshots/final-dark.png) | ![結果の棒グラフ](docs/screenshots/final-chart.png) |

| 変数 + 実行                                                                             |
| --------------------------------------------------------------------------------------- |
| ![パラメーター化されたクエリを駆動する変数パネル](docs/screenshots/final-variables.png) |

> Trino、MySQL、PostgreSQL の複数データソースと RBAC に対応しています
> （「データソース設定」「RBAC」各節を参照）。Hue のドキュメント共有は引き続き
> 対象外です。認証（oauth2-proxy による SSO +
> impersonation）とスケジュール実行は対応済みです（`docs/operations.md` §7 / §12）。

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
- **クエリスケジューラー** — 保存した SQL を cron で自動実行。登録・更新時と実行直前に Trino の `EXPLAIN (TYPE VALIDATE)` で構文・意味エラーを検証し、接続障害時は幾何バックオフで自動リトライします。

## アーキテクチャ

pnpm workspace の monorepo で、全体を TypeScript で記述しています。

```
packages/
  contracts/   # zod schemas + types — the API/type contract; server & web depend on it
  server/      # Hono BFF: multi-datasource query proxy (Trino / MySQL / PostgreSQL), SSE, CSV stream, PostgreSQL/SQLite persistence
  web/         # React 19 + Vite + Tailwind v4; Monaco editor; ECharts; zustand + TanStack Query
e2e/           # Playwright E2E suites (editor / execution / results / notebook / panels / chart / app) against a live Trino (tpch)
```

- **コントラクトファースト**: `packages/contracts` の zod 定義が正本（source of truth）で、
  server と web はその周りに位置する再生成可能な実装層です。
- **状態管理**: zustand のストア（`ui`、`notebook`、`execution`、チャート設定）+ サーバー
  状態は TanStack Query。コンポーネントはプレゼンテーションに徹します。
- **結果はメモリ上に保持**: 行データは server のメモリ + SSE に存在し、PostgreSQL（または
  SQLite）にはサマリ（notebooks、saved queries、history、セルごとの `resultMeta`）のみを
  永続化します。
- **design token はコントラクト**: 色 / 余白 / タイポグラフィはすべて
  `packages/web/src/theme/tokens.css` に置かれ、コンポーネント内での生 hex は ast-grep の
  lint ルールでブロックされます。Monaco と ECharts のテーマは実行時に `getComputedStyle`
  経由でこれらの token から導出されるため、どちらもテーマ切り替えに追従します。

## はじめに

前提: **Node 24 以上**、**pnpm 11**、そして到達可能な SQL エンジン（開発の既定は
**Trino**。e2e スイートとスクリーンショットは `tpch` カタログを前提とします。
例: `:30080` で動くローカル Trino）と **PostgreSQL**（アプリ自体の永続化。1st/production
推奨のバックエンドで、Docker Compose では同梱の `postgres` サービスが既定で立ち上がります）。
MySQL と PostgreSQL のデータソース追加は「データソース設定」各節の手順を参照してください。

最も手早く試すには Docker Compose を使います（Trino のデモと PostgreSQL の永続化が
一括で立ち上がります）。

```bash
docker compose up --build
# → http://localhost:8080 を開く
```

手元の Node で server/web を個別に立ち上げる場合は、`datasources.yaml` と PostgreSQL
（または SQLite）を用意してから起動します。

```bash
pnpm install

# datasources.yaml は必須(下記「データソース設定」参照)。ここでは最小の1件を用意する例。
cat > datasources.yaml <<'EOF'
datasources:
  - id: trino-default
    type: trino
    displayName: Trino
    username: admin
    baseUrl: http://localhost:30080
EOF

# Terminal 1 — the BFF (Hono) on :8080 (DATABASE_URL 未設定時は SQLite にフォールバック)
PORT=8080 DATABASE_URL=postgres://hubble:hubble@localhost:5432/hubble \
  pnpm --filter @hubble/server dev

# Terminal 2 — the web app (Vite) on :5173, proxying /api → :8080
pnpm --filter @hubble/web dev
```

そのうえで <http://localhost:5173> を開きます。（`pnpm dev` で両方を並行起動できます。）

### データソース設定（宣言的 YAML）

`datasources.yaml` は**必須**です。データソース（Trino / MySQL / PostgreSQL、複数可）を
ここで宣言します（例は `datasources.yaml.example`）。`DATASOURCES_PATH` でファイルパスを
指定でき、未設定時はカレントディレクトリの `datasources.yaml` を探します。どちらの
パスにもファイルが無い場合は起動時エラーになります（`TRINO_*` 環境変数からの自動合成は
廃止されました）。一覧は `GET /api/datasources` で取得できます（接続先や認証情報は
含みません）。

#### ホットリロード

`datasources.yaml` と `rbac.yaml` は、プロセス再起動なしで設定を反映できます。
`rbac.yaml` は起動時にファイルが無くても監視対象になり、後から配置すればリロードで
ロールが有効化されます。

- **ポーリング**: 環境変数 `CONFIG_RELOAD_INTERVAL_SECONDS`（既定 30、0 で無効）ごとに
  ファイルの更新時刻を確認し、変化があればリロードします。
- **SIGHUP**: シグナル受信時に即時リロードします（ポーリング間隔 0 でも有効）。
- **エラー時**: リロード中に YAML 不正やバリデーションエラーが起きた場合は現行設定を維持し、
  ログにエラーを出して次のポーリングへ進みます（起動時の読み込み失敗は従来どおり起動エラー）。
- **削除時**: 監視対象ファイルが削除された場合はリロードせず現行設定を維持し、
  warn ログを 1 回だけ出します。

k8s の ConfigMap 更新は kubelet の同期遅延（既定で最大 1 分程度）に加え、上記の
ポーリング間隔が乗算されます。反映までの遅延は両方の合算になる点に注意してください。

#### 種別ごとのフィールド

| フィールド                     | trino   | mysql   | postgresql   | 説明                                                             |
| ------------------------------ | ------- | ------- | ------------ | ---------------------------------------------------------------- |
| `id`                           | 必須    | 必須    | 必須         | 不変識別子（`^[a-z][a-z0-9-]{0,62}$`）                           |
| `type`                         | `trino` | `mysql` | `postgresql` | 種別                                                             |
| `displayName`                  | 任意    | 任意    | 任意         | UI 表示名（省略時は `id`）                                       |
| `username`                     | 必須    | 必須    | 必須         | 接続ユーザー                                                     |
| `passwordEnv` / `passwordFile` | 任意    | 任意    | 任意         | パスワード参照（後述）                                           |
| `baseUrl`                      | 必須    | —       | —            | Trino coordinator URL                                            |
| `source`                       | 任意    | —       | —            | ユーザークエリの `X-Trino-Source`（省略時 `hubble`）             |
| `metadataSource`               | 任意    | —       | —            | メタデータ取得の `X-Trino-Source`（省略時 `hubble-metadata`）    |
| `scheduledSource`              | 任意    | —       | —            | スケジュール実行の `X-Trino-Source`（省略時 `hubble-scheduled`） |
| `host`                         | —       | 必須    | 必須         | DB ホスト                                                        |
| `port`                         | —       | 任意    | 任意         | 省略時 3306 / 5432                                               |
| `database`                     | —       | 必須    | 必須         | データベース名                                                   |
| `readOnly`                     | —       | 任意    | 任意         | 省略時 `true`（後述）                                            |
| `tls`                          | —       | 任意    | 任意         | 省略時 `false`                                                   |
| `tlsCaFile`                    | —       | 任意    | 任意         | CA ファイル（`tls: true` 必須）                                  |
| `maxConnections`               | —       | 任意    | 任意         | プール上限（省略時 5）                                           |

#### パスワードの参照

パスワードは YAML に直接書きません。

- `passwordEnv`: 環境変数名。Docker Compose では `environment` に載せるのが素直です。
- `passwordFile`: ファイルパス。Kubernetes では Secret をボリュームマウントして
  `passwordFile: /etc/hubble/secrets/mysql-password` のように参照するのが一般的です。
- 両方を同時に指定することはできません。

#### readOnly と Query Guard

- `readOnly`（mysql/postgresql、省略時 `true`）は接続時に読み取り専用セッションを
  設定するガードレールです（MySQL: `SET SESSION TRANSACTION READ ONLY`、
  PostgreSQL: `SET default_transaction_read_only = on`）。ユーザーが `SET` で
  解除できる可能性があるため、本番の書き込み防止は DB 側の権限で行ってください。
- mysql / postgresql では EXPLAIN によるスキャン量見積り（Query Guard）に非対応です。
  UI の見積りストリップは無効化され、`POST /api/queries/estimate` は
  `ESTIMATE_NOT_SUPPORTED` を返します。`enforce` モードでもクエリ実行自体はブロックされません。

#### Docker Compose デモ（Trino + MySQL + PostgreSQL）

既定の `docker compose up` は従来どおり Trino のみです。3 データソースを試すときは
デモ用オーバーレイと `demo` プロファイルを使います。

```bash
# ビルドと起動 (Hubble + Trino + demo-mysql + demo-postgres)
docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo up --build

# http://localhost:8080 を開き、TopBar のデータソースセレクタで切り替え
# demo-postgres はアプリ永続化用 DATABASE_URL とは別サービスです
```

定義ファイルは `deploy/compose/datasources.demo.yaml` です。ホストから DB に直接つなぐ場合は
`127.0.0.1:3307`（MySQL）と `127.0.0.1:5434`（PostgreSQL）が公開されます。

### RBAC（ロール定義）

ロールと権限は `rbac.yaml` で宣言します（例は `rbac.yaml.example`）。
`RBAC_PATH` でファイルパスを指定でき、未設定時はカレントディレクトリの
`rbac.yaml` を探します。ファイルが無い場合は組み込みロール `unrestricted`
（`query.write` のみ）が全員に割り当てられ、従来どおり全ユーザーが書き込み可能です。
`query.write` 権限の有無で書き込み文の実行を拒否し、ロールごとに Query Guard 上限を
上書きできます。割り当てキーは `email` / `user` / `emailDomain` / `group` のいずれか
1 つです。`group` は oauth2-proxy 等が付与する `X-Forwarded-Groups` ヘッダー
（`AUTH_SSO_HEADER_GROUPS`、既定 `x-forwarded-groups`）のメンバーシップと照合します。
Google Workspace のグループを使う場合は、oauth2-proxy の Google provider で
グループ解決を有効にする必要があります。
スケジュール実行時のロール解決は owner 文字列のみを使います
（`{ user: owner, email: owner に '@' が含まれるとき }`）。そのため
`AUTH_USER_MAPPING=email-localpart` では email 系 assignment がスケジュール実行に
効きません。`group` 割り当てもスケジュール実行には適用されず `defaultRole` 等へ
落ちます。スケジュールでもロールを固定したい運用では `email` / `user` での割り当てを
使ってください。email 系 assignment をスケジュールでも使う場合は owner をメールアドレス
形式で保存するか、`user` / `email` マッピングを使ってください。
設定変更はプロセス再起動後に反映されます。

#### 運用ビュー（Operations）

`queries.viewAll` 権限を持つユーザーにだけ、サイドバーに Operations ビューが表示されます。
全ユーザーの実行中クエリ（TTL 内に保持されている終了済みクエリを含む）を一覧し、
owner、データソース、statement 先頭、state、経過時間を 5 秒間隔で更新します。
`query.killAny` 権限を持つユーザーは、確認ダイアログ経由で任意ユーザーのクエリを
kill できます。kill 操作はサーバーログに 1 行（実行者、対象 owner、queryId）を残します。
`rbac.yaml` が無い `unrestricted` 運用ではこれらの権限は付与されず、従来どおりの UI です。

#### datasource 露出の制限（`role.datasources`）

MySQL/PostgreSQL は `datasources.yaml` の単一 credential で全ユーザーのクエリを実行するため、
DB 側の行/テーブル単位の認可や監査には principal が伝播しません。Hubble 側では
`rbac.yaml` の各ロールに任意フィールド `datasources` を設定し、クエリ、見積り、メタデータ、
スケジュールで利用できる datasource id を allowlist で制限できます。未指定時は従来どおり
全 datasource が許可されます。`GET /api/datasources` もロールに応じて一覧が filter され、
UI から見えない datasource を選べなくなります。厳密な DB 側の境界が必要な場合は Trino 経由での
接続を推奨します。

#### 既知の制限（MySQL/PostgreSQL）

MySQL/PostgreSQL は `datasources.yaml` の単一 credential で全ユーザーのクエリを実行するため、
DB 側の行/テーブル単位の認可や監査にはユーザーが伝播しません。`role.datasources` は Hubble 上の
露出 datasource を制限するものであり、許可された MySQL/PostgreSQL へ到達したクエリは依然として
共有 credential で実行されます。厳密な境界が必要な場合は Trino 経由での接続を推奨します。

### 環境変数（server）

| 変数                              | 既定値               | 説明                                                                                                                                         |
| --------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATASOURCES_PATH`                | —                    | データソース定義 YAML のパス（必須）。未設定時は `./datasources.yaml` を探し、どちらにも無ければ起動時エラー                                 |
| `RBAC_PATH`                       | —                    | RBAC 定義 YAML のパス。未設定時は `./rbac.yaml` を探し、無ければ `unrestricted` ロールで後方互換                                             |
| `CONFIG_RELOAD_INTERVAL_SECONDS`  | `30`                 | `datasources.yaml` / `rbac.yaml` のホットリロードのポーリング間隔（秒）。`0` で SIGHUP のみ                                                  |
| `PORT`                            | `8080`               | BFF が待ち受ける HTTP ポート                                                                                                                 |
| `DATABASE_URL`                    | —                    | `postgres://` / `postgresql://` 形式の接続文字列（1st/production 推奨）。設定すると永続化バックエンドが PostgreSQL になり `DB_PATH` より優先 |
| `DB_PATH`                         | `./data/hubble.db`   | SQLite データベースファイル（non-production 向け。`DATABASE_URL` 未設定時のみ使われる）                                                      |
| `STATIC_DIR`                      | —                    | ビルド済み web アプリのディレクトリ（例 `packages/web/dist`）。配信 + SPA フォールバックを担う                                               |
| `TRINO_USER`                      | `admin`              | 全 Trino データソース共通の `X-Trino-User`（impersonation ユーザー）。`AUTH_MODE=none` の principal 兼 owner backfill の初期値               |
| `DEFAULT_CATALOG`                 | —                    | 新規 notebook の初期カタログ                                                                                                                 |
| `DEFAULT_SCHEMA`                  | —                    | 新規 notebook の初期スキーマ                                                                                                                 |
| `DEFAULT_LIMIT`                   | `5000`               | `LIMIT` のない `SELECT` に自動付与する `LIMIT`                                                                                               |
| `QUERY_MAX_ROWS`                  | `100000`             | クエリごとに server 側でバッファする行数の上限                                                                                               |
| `QUERY_CONCURRENCY`               | `5`                  | 同時に追跡するクエリ数の上限                                                                                                                 |
| `QUERY_TTL_MINUTES`               | `30`                 | 完了したクエリを掃除するまでの保持時間                                                                                                       |
| `QUERY_OVERFLOW_MODE`             | `truncate`           | `QUERY_MAX_ROWS` 超過時の挙動（`truncate` または `cancel`）                                                                                  |
| `METADATA_TTL_SECONDS`            | `300`                | メタデータキャッシュの TTL                                                                                                                   |
| `APP_VERSION`                     | `0.1.0`              | `GET /api/config` が返すバージョン                                                                                                           |
| `QUERY_GUARD_MODE`                | `warn`               | Query Guard モード（`off`=無効 / `warn`=推定表示のみ / `enforce`=上限超過時に HTTP 422 で拒否）                                              |
| `QUERY_GUARD_MAX_SCAN_BYTES`      | `0`（無制限）        | スキャンバイト数の上限（0 = 無制限）                                                                                                         |
| `QUERY_GUARD_MAX_SCAN_ROWS`       | `0`（無制限）        | スキャン行数の上限（0 = 無制限）                                                                                                             |
| `QUERY_GUARD_ON_UNKNOWN`          | `warn`               | 統計が無く推定不能なときの扱い（`allow` / `warn` / `block`）                                                                                 |
| `QUERY_GUARD_ESTIMATE_TIMEOUT_MS` | `3000`               | EXPLAIN のタイムアウト（ミリ秒）                                                                                                             |
| `QUERY_GUARD_CACHE_TTL_SECONDS`   | `30`                 | 推定結果キャッシュの TTL（秒）                                                                                                               |
| `QUERY_GUARD_BYTES_PER_SECOND`    | `0`（目安なし）      | クラスタースループット目安（バイト/秒）。0 より大きい値を設定すると UI に所要時間の目安を表示                                                |
| `SCHEDULER_ENABLED`               | `true`               | `false` にするとスケジューラーの tick ループを停止（API は生きたまま）                                                                       |
| `SCHEDULER_TICK_SECONDS`          | `15`                 | due なスケジュールをスキャンする間隔（秒）                                                                                                   |
| `SCHEDULER_MAX_CONCURRENT`        | `2`                  | スケジューラー全体で同時実行できる数の上限                                                                                                   |
| `SCHEDULER_RUNS_RETENTION`        | `50`                 | スケジュールごとに保持する実行履歴の上限件数（古い行は自動プルーン）                                                                         |
| `AUTH_SSO_HEADER_GROUPS`          | `x-forwarded-groups` | SSO グループ membership ヘッダー名（`rbac.yaml` の `group` 割り当てに使用）                                                                  |

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

# Multi-datasource E2E (optional; does not run in the default command above)
# Start demo DBs: docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo up -d demo-mysql demo-postgres
MULTI_DS_E2E=1 pnpm --filter @hubble/e2e test tests/datasources.spec.ts
```

E2E スイート（editor / execution / results / notebook / panels / chart / app にわたる
35 テスト）は、決定的な `tpch.tiny` / `tpch.sf1` データを持つ本物の Trino に対して実行
します。インメモリの SQLite（`DB_PATH=:memory:`）を使うため自分の notebook には一切
触れず、`QUERY_MAX_ROWS=10000` で truncation の経路を確認します。

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

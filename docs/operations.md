# Hubble SQL Workbench 運用ガイド

このドキュメントは、社内で **Hubble SQL Workbench**（以下 Hubble）をホストする運用者
向けの導入・設定・運用マニュアルです。利用者向けの操作は [`user-guide.md`](user-guide.md)
を参照してください。

> 本書に載せた起動・確認コマンドは、Trino 稼働中の環境で実機検証しています
> （oauth2-proxy の実体は不要。`AUTH_MODE=proxy` のヘッダ注入は curl で検証）。

---

## 1. アーキテクチャ概要

Hubble は **Hono 製の BFF（server）+ React 製の web** からなる単一プロセスのアプリです。
`STATIC_DIR` に web のビルド成果物を指すと、server が静的ファイル配信も担うため、
プロセスは 1 つで完結します。永続化は PostgreSQL（1st/production 推奨）または SQLite
（non-production 向け、[§9](#9-データ管理)）、データソースは `datasources.yaml`
で宣言する Trino / MySQL / PostgreSQL のマルチデータソースに対応します。

```mermaid
flowchart LR
  browser["ブラウザ"]
  proxy["oauth2-proxy\n(SSO 前段、任意)"]
  server["hubble server (Hono)\n+ 静的配信 (web/dist)"]
  trino["Trino"]
  mysql["MySQL"]
  postgresDs["PostgreSQL\n(データソース)"]
  db[("永続化 DB\nPostgreSQL(主) / SQLite(代替)\napplication tables / object refs")]

  browser -->|認証ヘッダ付与(任意)| proxy
  proxy -->|X-Forwarded-User/Email| server
  browser -.->|AUTH_MODE=none 時は直接| server
  server -->|Basic auth + X-Trino-User: principal| trino
  server -->|datasources.yaml の credential| mysql
  server -->|datasources.yaml の credential| postgresDs
  server --> db
```

- **認証なし（`AUTH_MODE=none`、既定）**: oauth2-proxy を置かず、Trino には固定の
  `TRINO_USER` で接続します。ローカル・単一ユーザー・E2E 用。
- **SSO（`AUTH_MODE=proxy`）**: oauth2-proxy を前段に置き、付与された SSO ヘッダから
  principal を解決します。Trino へは技術アカウントの Basic auth で接続しつつ、
  `X-Trino-User: <principal>` で **impersonation** します。MySQL/PostgreSQL データソースは
  `datasources.yaml` の単一 credential で接続するため、principal は伝播しません（[§6.3](#63-メタデータ実行ユーザーとカタログ可視性)）。

`X-Trino-Source` を 4 値（`hubble` / `hubble-metadata` / `hubble-download` / `hubble-scheduled`）で送るため、
Trino 側の resource group で「ユーザークエリ／メタデータ取得／ダウンロード再実行／スケジュール実行」を
分離できます（[§8.3](#83-resource-group-分離source-別)）。

---

## 2. 必要要件

| 項目                 | 要件                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Node.js              | **24 以上**                                                                                                                   |
| パッケージマネージャ | **pnpm 11**（`packageManager` は `pnpm@11.6.0`）                                                                              |
| データソース         | `datasources.yaml` で宣言する Trino / MySQL / PostgreSQL のうち 1 件以上（Trino は Basic auth と impersonation の設定が前提） |
| 永続化 DB            | PostgreSQL（推奨）。SQLite（non-production）を使う場合のみ `better-sqlite3` のネイティブビルドのため Linux 推奨               |

server は TypeScript ソースを `tsx` ランタイムで直接実行します（contracts も TS ソースを
そのまま参照する設計のため、別途のトランスパイル成果物は不要）。

---

## 3. ビルドとデプロイ（単一プロセス）

### 3.1 依存解決と web ビルド

```bash
pnpm install
pnpm --filter web build      # → packages/web/dist/ に index.html + ハッシュ付き assets
```

### 3.2 単一プロセス起動

`STATIC_DIR` に web のビルド成果物（絶対パス推奨）を渡して server を起動します。
`pnpm --filter @hubble/server start` は内部で `tsx src/index.ts` を実行します。

```bash
PORT=8080 \
DATABASE_URL=postgres://hubble:***@postgres.internal:5432/hubble \
STATIC_DIR=/opt/hubble/packages/web/dist \
DATASOURCES_PATH=/etc/hubble/datasources.yaml \
TRINO_USER=hubble-svc \
  pnpm --filter @hubble/server start
```

`datasources.yaml`（`DATASOURCES_PATH` が指すファイル）に Trino の `baseUrl` / `username` /
`passwordEnv`|`passwordFile` を書きます（必須ファイル、例は `datasources.yaml.example`）。
`TRINO_USER` は全 Trino データソース共通の impersonation ユーザーです。

起動ログに次が出れば配信込みで立ち上がっています。

```
hubble server listening on http://localhost:8080
serving static web app from /opt/hubble/packages/web/dist
```

`STATIC_DIR` が存在しないと警告を出して起動します（API のみ稼働）。

### 3.3 動作確認（curl）

```bash
# ヘルスチェック（認証不要）
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/healthz   # → 200

# DB と既定エンジンの受付可能状態（認証不要）
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/readyz    # → 200

# SPA シェル（index.html, no-cache）
curl -s -D - -o /dev/null http://localhost:8080/ | grep -iE "HTTP/|cache-control|content-type"
#   HTTP/1.1 200 OK
#   cache-control: no-cache
#   content-type: text/html; charset=utf-8

# 公開設定（GET /api/config）
curl -s http://localhost:8080/api/config
#   {"trino":{...},"defaults":{...},"authMode":"none","version":"0.1.0"}
```

静的配信の挙動：

- `index.html` は `Cache-Control: no-cache`（デプロイを即時反映）。
- ハッシュ付き assets（`assets/index-XXXX.js` 等）は
  `Cache-Control: public, max-age=31536000, immutable`。
- `Accept-Encoding: gzip` を送る client には、JS、CSS、SVG 等の text asset を gzip 配信。
- `favicon.svg` 等のハッシュを持たない asset は `Cache-Control: no-cache`。
- `/api` 以外の未マッチパス（ディープリンク）は `index.html` にフォールバック（SPA）。
- `/api/*` は静的配信の影響を受けません。未知の `/api` パスは JSON のエラー封筒
  （`{"error":{"code":"NOT_FOUND",...}}`）を返します。

### 3.4 systemd unit 例

```ini
# /etc/systemd/system/hubble.service
[Unit]
Description=Hubble SQL Workbench
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hubble
WorkingDirectory=/opt/hubble
ExecStart=/usr/bin/pnpm --filter @hubble/server start
Restart=on-failure
RestartSec=3

# 環境変数（または EnvironmentFile=/etc/hubble.env）
Environment=PORT=8080
Environment=STATIC_DIR=/opt/hubble/packages/web/dist
Environment=DATASOURCES_PATH=/etc/hubble/datasources.yaml
Environment=TRINO_USER=hubble-svc
# 機密は EnvironmentFile に分離するのが望ましい:
# EnvironmentFile=/etc/hubble.env   (DATABASE_URL=postgres://... 、TRINO_PASSWORD=... など)

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hubble
sudo systemctl status hubble
journalctl -u hubble -f
```

oauth2-proxy を前段に置く場合は、Hubble を `127.0.0.1:8080`（loopback）に bind し、
proxy をその upstream にするのが安全です（[§7](#7-認証-auth_modeproxy)）。

---

## 4. 環境変数リファレンス

正本は `packages/server/src/config.ts` です。未設定（または空文字）のとき既定値が使われます。

| 変数                              | 既定値                            | 説明                                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                            | `8080`                            | BFF の HTTP ポート                                                                                                                                                                                                              |
| `HTTP_MAX_BODY_BYTES`             | `2097152`                         | API request body 全体の最大 byte 数。超過時は JSON の解析前に HTTP 413 で拒否                                                                                                                                                   |
| `SHUTDOWN_TIMEOUT_MS`             | `60000`                           | HTTP 受付停止から強制 close へ移るまでの期限（ミリ秒）                                                                                                                                                                          |
| `DATABASE_URL`                    | （未設定 = SQLite を使用）        | `postgres://` / `postgresql://` 形式の接続文字列（1st/production 推奨）。設定すると永続化バックエンドが PostgreSQL になり `DB_PATH` より優先されます。それ以外のスキームは起動時エラー（[§9.1](#91-postgresql-バックエンド主)） |
| `DB_PATH`                         | `./data/hubble.db`                | SQLite ファイルパス（non-production 向け。`DATABASE_URL` 未設定時のみ使用）。`:memory:` で揮発（テスト用）                                                                                                                      |
| `DATABASE_CONNECT_TIMEOUT_MS`     | `10000`                           | アプリ永続化用 PostgreSQL の接続と pool 取得を待つ上限（ミリ秒）。datasource 用の接続期限とは独立                                                                                                                               |
| `DATABASE_STATEMENT_TIMEOUT_MS`   | `30000`                           | アプリ永続化用 PostgreSQL で単一 SQL 文を実行できる上限（ミリ秒）。migration と repository query にも適用                                                                                                                       |
| `DATABASE_LOCK_TIMEOUT_MS`        | `10000`                           | アプリ永続化用 PostgreSQL でロック取得を待つ上限（ミリ秒）。migration の advisory lock にも適用                                                                                                                                 |
| `DATABASE_IDLE_TX_TIMEOUT_MS`     | `30000`                           | アプリ永続化用 PostgreSQL でトランザクション内のアイドル状態を許す上限（ミリ秒）                                                                                                                                                |
| `DATABASE_TRANSACTION_TIMEOUT_MS` | `60000`                           | アプリ永続化用 PostgreSQL で BEGIN から COMMIT までを待つ上限（ミリ秒）。超過時は pinned connection を破棄。未確定 transaction は rollback され、COMMIT と競合した場合の成否は不明                                              |
| `STATIC_DIR`                      | （未設定 = 配信しない）           | web ビルド成果物のディレクトリ。設定時に静的配信 + SPA フォールバック                                                                                                                                                           |
| `DATASOURCES_PATH`                | （未設定 = `./datasources.yaml`） | データソース定義 YAML のパス（**必須ファイル**）。未設定時のパスにもファイルが無ければ起動時エラー（[§1](#1-アーキテクチャ概要)、`datasources.yaml.example`）                                                                   |
| `RBAC_PATH`                       | （未設定 = `./rbac.yaml`）        | RBAC 定義 YAML のパス。未設定時のパスにファイルが無ければ組み込みロール `unrestricted` にフォールバック（README の RBAC 節参照）                                                                                                |
| `CONFIG_RELOAD_INTERVAL_SECONDS`  | `30`                              | `datasources.yaml` / `rbac.yaml` のホットリロードのポーリング間隔（秒）。`0` で SIGHUP のみ                                                                                                                                     |
| `TRINO_USER`                      | `admin`                           | 全 Trino データソース共通の `X-Trino-User`（none モードの実行ユーザー兼所有者。proxy モードでは SSO から解決した principal がクエリとメタデータ双方の impersonation に使われる）                                                |
| `DEFAULT_CATALOG`                 | （未設定）                        | 新規 Notebook の初期カタログ                                                                                                                                                                                                    |
| `DEFAULT_SCHEMA`                  | （未設定）                        | 新規 Notebook の初期スキーマ                                                                                                                                                                                                    |
| `DEFAULT_LIMIT`                   | `5000`                            | LIMIT 無しの `SELECT` に自動付加する行数                                                                                                                                                                                        |
| `QUERY_MAX_ROWS`                  | `100000`                          | 1 クエリでサーバー側にバッファする行数上限                                                                                                                                                                                      |
| `QUERY_CONCURRENCY`               | `5`                               | 同時に追走（トラッキング）するクエリ数の上限                                                                                                                                                                                    |
| `QUERY_MAX_QUEUED`                | `100`                             | 実行枠を待てるクエリの全体上限。超過時は HTTP 429 と `QUERY_QUEUE_FULL` で拒否                                                                                                                                                  |
| `QUERY_MAX_QUEUED_PER_PRINCIPAL`  | `20`                              | 同一 principal が実行枠を待てるクエリの上限。超過時は HTTP 429 と `QUERY_PRINCIPAL_QUEUE_FULL` で拒否                                                                                                                           |
| `QUERY_MAX_TRACKED`               | `10000`                           | 終端済みを含めて registry が保持するクエリの上限。期限切れを掃除しても上限なら HTTP 429 と `QUERY_REGISTRY_FULL` で拒否                                                                                                         |
| `QUERY_TTL_MINUTES`               | `30`                              | 完了クエリを保持してから sweep するまでの分数                                                                                                                                                                                   |
| `QUERY_OVERFLOW_MODE`             | `truncate`                        | `QUERY_MAX_ROWS` 超過時の挙動（`truncate` = 打ち切り / `cancel` = 中止）                                                                                                                                                        |
| `METADATA_TTL_SECONDS`            | `300`                             | メタデータキャッシュの TTL（秒）                                                                                                                                                                                                |
| `RESULT_STORE`                    | `none`                            | クエリ結果の保存先（`none` / `s3`）。`s3` のとき完了結果を zstd 圧縮 JSONL で S3 へ保存します                                                                                                                                   |
| `RESULT_STORE_TTL_DAYS`           | `7`                               | 保存済み結果の保持日数。期限切れ後は起動時と日次の掃除で S3 object を削除し、DB の object key を NULL に戻します                                                                                                                |
| `RESULT_STORE_S3_BUCKET`          | （未設定）                        | `RESULT_STORE=s3` のとき必須の S3 bucket 名                                                                                                                                                                                     |
| `RESULT_STORE_S3_PREFIX`          | `hubble-results/`                 | S3 object key の prefix。末尾の `/` を必須とします                                                                                                                                                                              |
| `RESULT_STORE_S3_REGION`          | （未設定）                        | S3 client の region。AWS SDK 標準チェーンと環境の既定に任せる場合は未設定                                                                                                                                                       |
| `RESULT_STORE_S3_ENDPOINT`        | （未設定）                        | S3 互換エンドポイント。設定時は path-style request を使います                                                                                                                                                                   |
| `EXPORT_S3_BUCKET`                | （未設定）                        | 結果ペインの S3 エクスポート先 bucket 名。未設定時は S3 エクスポート API が HTTP 501 で拒否します                                                                                                                               |
| `EXPORT_S3_PREFIX`                | `hubble-exports/`                 | S3 エクスポートの object key prefix。実際の key は `<prefix>/<owner>/<queryId>-<timestamp>.<ext>` です                                                                                                                          |
| `EXPORT_S3_REGION`                | （未設定）                        | S3 エクスポート用 client の region。AWS SDK 標準チェーンと環境の既定に任せる場合は未設定                                                                                                                                        |
| `EXPORT_S3_ENDPOINT`              | （未設定）                        | S3 互換エンドポイント。設定時は path-style request を使います                                                                                                                                                                   |
| `EXPORT_SHEETS_CREDENTIALS_FILE`  | （未設定）                        | Google Sheets エクスポートに使う service account JSON のパス。未設定時は Google Sheets エクスポート API が HTTP 501 で拒否します                                                                                                |
| `APP_VERSION`                     | `0.1.0`                           | `GET /api/config` が返すバージョン                                                                                                                                                                                              |
| `AUTH_MODE`                       | `none`                            | 認証モード（`none` / `proxy`、[§7](#7-認証-auth_modeproxy)）                                                                                                                                                                    |
| `AUTH_TRUSTED_PROXY_CIDRS`        | `127.0.0.0/8,::1/128`             | SSO ヘッダを信頼する送信元 CIDR（カンマ区切り）                                                                                                                                                                                 |
| `AUTH_SSO_HEADER_USER`            | `x-forwarded-user`                | SSO ユーザー名ヘッダ名（小文字比較）                                                                                                                                                                                            |
| `AUTH_SSO_HEADER_EMAIL`           | `x-forwarded-email`               | SSO メールヘッダ名（小文字比較）                                                                                                                                                                                                |
| `AUTH_SSO_HEADER_GROUPS`          | `x-forwarded-groups`              | SSO グループ membership ヘッダー名（小文字比較。`rbac.yaml` の `group` 割り当てに使用）                                                                                                                                         |
| `AUTH_USER_MAPPING`               | `email-localpart`                 | principal の導出方法（`email-localpart` / `email` / `user`）                                                                                                                                                                    |
| `QUERY_GUARD_MODE`                | `warn`                            | Query Guard の動作モード（`off`=無効 / `warn`=推定表示のみ、ブロックしない / `enforce`=上限超過時にサーバーが実行を拒否。HTTP 422, code `QUERY_BLOCKED`）                                                                       |
| `QUERY_GUARD_MAX_SCAN_BYTES`      | `0`（無制限）                     | スキャンバイト数の上限。0 は無制限                                                                                                                                                                                              |
| `QUERY_GUARD_MAX_SCAN_ROWS`       | `0`（無制限）                     | スキャン行数の上限。0 は無制限                                                                                                                                                                                                  |
| `QUERY_GUARD_ON_UNKNOWN`          | `warn`                            | 統計が無く推定できないときの扱い（`allow` / `warn` / `block`）                                                                                                                                                                  |
| `QUERY_GUARD_ESTIMATE_TIMEOUT_MS` | `3000`                            | EXPLAIN タイムアウト（ミリ秒）。超過時は推定不能扱い                                                                                                                                                                            |
| `QUERY_GUARD_CACHE_TTL_SECONDS`   | `30`                              | 推定結果キャッシュの TTL（秒）                                                                                                                                                                                                  |
| `QUERY_GUARD_BYTES_PER_SECOND`    | `0`（目安なし）                   | クラスタースループットの目安（バイト/秒）。0 以外を設定すると UI に「所要時間目安 = 推定スキャンバイト ÷ この値」を表示                                                                                                         |
| `SCHEDULER_ENABLED`               | `true`                            | `false` にするとスケジューラーの tick ループを起動しない（API は生きたまま、スケジュールの登録や閲覧は可能）                                                                                                                    |
| `SCHEDULER_TICK_SECONDS`          | `15`                              | due なスケジュールをスキャンする間隔（秒）                                                                                                                                                                                      |
| `SCHEDULER_MAX_CONCURRENT`        | `2`                               | schedule、workflow step、alert で共有する statement 同時実行上限                                                                                                                                                                |
| `SCHEDULER_RUNS_RETENTION`        | `50`                              | スケジュールごとに保持する実行履歴の上限行数（古い行はプルーン）                                                                                                                                                                |
| `ALERT_DELIVERY_RETENTION_DAYS`   | `30`                              | `sent` または `dead` になった Alert 通知 outbox の保持日数。`0` は自動削除しない                                                                                                                                                |
| `QUERY_HISTORY_RETENTION_DAYS`    | `90`                              | S3 result 参照を持たないクエリ履歴の保持日数。`0` は自動削除しない                                                                                                                                                              |
| `AUDIT_LOG_RETENTION_DAYS`        | `365`                             | 監査ログの保持日数。`0` は自動削除せず、法令と社内規程に合わせて必要なログを削除前にエクスポートする                                                                                                                            |
| `DATA_RETENTION_BATCH_SIZE`       | `500`                             | 保持期限 cleanup が1回の DELETE で処理する最大行数。小さくすると1回の lock 保持時間を短縮できる                                                                                                                                 |
| `NOTIFY_SLACK_WEBHOOK_URL`        | （未設定）                        | スケジュール確定失敗通知で使う Slack incoming webhook URL。未設定時に Slack チャネルを選んだスケジュールは warn ログを出してスキップ                                                                                            |
| `NOTIFY_SMTP_HOST`                | （未設定）                        | スケジュール確定失敗通知で使う SMTP ホスト。未設定時に email チャネルを選んだスケジュールは warn ログを出してスキップ                                                                                                           |
| `NOTIFY_SMTP_PORT`                | `587`                             | SMTP ポート。`465` は implicit TLS、それ以外は SMTP サーバーが対応する場合に STARTTLS を使う                                                                                                                                    |
| `NOTIFY_SMTP_USER`                | （未設定）                        | SMTP 認証ユーザー。未設定時は認証なし                                                                                                                                                                                           |
| `NOTIFY_SMTP_PASSWORD_ENV`        | （未設定）                        | SMTP パスワードを読む環境変数名。例: `NOTIFY_SMTP_PASSWORD_ENV=SMTP_PASSWORD` と `SMTP_PASSWORD=...`                                                                                                                            |
| `NOTIFY_SMTP_FROM`                | （未設定）                        | SMTP の From アドレス。email チャネルでは必須                                                                                                                                                                                   |
| `GITHUB_REPO`                     | （未設定 = 機能無効）             | push 先 GitHub リポジトリ (`owner/repo`)。設定時は `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` / `GITHUB_TOKEN_ENCRYPTION_KEY` が必須（[§13](#13-github-連携)）                                                         |
| `GITHUB_DEFAULT_BRANCH`           | `main`                            | 承認判定の基準となるデフォルトブランチ名                                                                                                                                                                                        |
| `GITHUB_APP_CLIENT_ID`            | （未設定）                        | GitHub App の OAuth Client ID。`GITHUB_REPO` 設定時は必須                                                                                                                                                                       |
| `GITHUB_APP_CLIENT_SECRET`        | （未設定）                        | GitHub App の OAuth Client Secret。`GITHUB_REPO` 設定時は必須                                                                                                                                                                   |
| `GITHUB_TOKEN_ENCRYPTION_KEY`     | （未設定）                        | ユーザー OAuth トークンを AES-256-GCM で暗号化する 32 バイト鍵 (base64)。`openssl rand -base64 32` で生成。`GITHUB_REPO` 設定時は必須                                                                                           |
| `GITHUB_TOKEN_ENCRYPTION_KEY_ID`  | `default`                         | active token master key の識別子。英数字、`_`、`-` を使用し、鍵を切り替えるたびに新しい値へ変更する                                                                                                                             |
| `GITHUB_TOKEN_ENCRYPTION_KEYRING` | （未設定）                        | 旧 key ID と旧 32 バイト master key の JSON object。例: `{"2026q1":"base64..."}`。旧暗号文を active key へ遅延再暗号化する間だけ設定する                                                                                        |
| `GITHUB_GOVERNANCE`               | `off`                             | ガバナンス強制 (`off` / `on`)。`on` のとき `GITHUB_REPO` 設定が前提で、承認済みドキュメント由来の SQL のみ RESULT_STORE へ永続化し、未承認ワークフローの cron 実行を blocked にする ([§13](#13-github-連携) のガバナンス強制)   |
| `GITHUB_STATUS_TTL_SECONDS`       | `120`                             | ドキュメント承認ステータス (デフォルトブランチとのハッシュ比較) のキャッシュ TTL (秒)                                                                                                                                           |
| `GITHUB_SYNC_CRON`                | `0 3 * * *`                       | デフォルトブランチ (`GITHUB_DEFAULT_BRANCH`) からの定時取り込み cron (5 フィールド、サーバーのローカル TZ)。`off` で無効 ([§13](#13-github-連携) の定時同期)                                                                    |
| `GITHUB_SYNC_TOKEN`               | （未設定）                        | 定時取り込み用の読み取りトークン (任意。fine-grained PAT で `contents:read`)。設定時は各ドキュメント owner の接続トークンより優先 ([§13](#13-github-連携) の定時同期)                                                           |
| `AI_PROVIDER`                     | `off`                             | AI アシスタント provider（`off` / `gemini-api` / `github-models`）。`off` のとき `POST /api/ai/assist` は HTTP 501 で拒否し、UI にも入口を表示しません                                                                          |
| `AI_MODEL`                        | provider ごとに既定               | 使用モデル名。`gemini-api` の既定は `gemini-2.5-flash`、`github-models` の既定は `openai/gpt-4o-mini`                                                                                                                           |
| `AI_API_KEY_ENV`                  | provider ごとに既定               | API key/token を読む環境変数名。`gemini-api` の既定は `GEMINI_API_KEY`、`github-models` の既定は `GITHUB_MODELS_TOKEN`。指し先の環境変数が未設定なら起動時エラー                                                                |
| `AI_TIMEOUT_MS`                   | `60000`                           | AI provider 呼び出しのタイムアウト（ミリ秒）。超過時はストリームに `error` イベントを送出                                                                                                                                       |

不正な整数・列挙値（例 `AUTH_MODE=foo`）は起動時にエラーで停止します。

---

## 5. （参考）開発時の起動

開発時は server と web を別プロセスで立ち上げ、Vite が `/api` を server にプロキシします。

```bash
pnpm dev   # server(:8080) と web(:5173) を並列起動
# → http://localhost:5173
```

本番（単一プロセス）では [§3](#3-ビルドとデプロイ単一プロセス) を使ってください。

---

## 6. Trino 側の要件

### 6.1 技術アカウントと Basic auth

Hubble は固定の技術アカウント（`datasources.yaml` の Trino エントリの `username` /
`passwordEnv`|`passwordFile`）で Trino に Basic auth 接続します。`baseUrl` が HTTPS で
ないと Trino が Basic auth を拒否する構成もあるため、本番では TLS 終端（直接 or
リバースプロキシ）を用意してください。

### 6.2 impersonation 許可（proxy モード）

proxy モードでは、各ユーザークエリが `X-Trino-User: <principal>` で実行されます。Trino 側で
**技術アカウントが任意ユーザーへ impersonation できる**設定が必要です。file-based system
access control の例：

`etc/access-control.properties`:

```properties
access-control.name=file
security.config-file=etc/rules.json
security.refresh-period=1s
```

`etc/rules.json`（impersonation ルールの例。技術アカウント `hubble-svc` が任意ユーザーに
なりすませる）:

```json
{
  "impersonation": [
    {
      "original_user": "hubble-svc",
      "new_user": ".*",
      "allow": true
    }
  ],
  "catalogs": [{ "user": ".*", "catalog": ".*", "allow": "read-only" }]
}
```

`original_user` は Basic auth の認証ユーザー（= `datasources.yaml` の該当 Trino エントリの
`username`）、`new_user` は `X-Trino-User` の principal です。実運用では `new_user` を
社内ユーザーの命名規則に合わせて絞ってください。

### 6.3 メタデータ実行ユーザーとカタログ可視性

Trino データソースのメタデータ取得（カタログ／スキーマ／テーブル一覧、サンプル）は
リクエスト principal（`X-Trino-User`）で impersonation 実行され、キャッシュは
principal ごとに独立しています。Trino 側の access control により、ユーザーごとに
見えるカタログ・スキーマ・サンプル行が異なります。

MySQL/PostgreSQL データソースは、既定では `datasources.yaml` の datasource 本体の credential で接続します。
`roleCredentials` を設定した場合は、解決済み RBAC role に対応する credential で接続します。
いずれの場合も Trino のようなユーザー単位の principal は DB 側へ伝播しないため、Hubble 側では `rbac.yaml` の `role.datasources` で露出する datasource id を allowlist 制限してください。
未指定のロールは後方互換のため全 datasource を利用できます。拒否時は datasource の存在有無を
漏らさないよう HTTP 404 として応答します。
RBAC 設定を変更した後は、信頼済み proxy ヘッダーで `/api/me` を呼び、解決された `role`、`permissions`、`datasources` を確認してください。
ブラウザでは TopBar の UserChip から同じ情報を確認できます。

#### MySQL/PostgreSQL の roleCredentials 運用

DB 側では role ごとに別 DB ユーザーを作成し、スキーマ、テーブル、DB に必要な `GRANT` を付与してください。
`roleCredentials` を増やすと、接続プールは datasource と role の組み合わせごとに作られるため、最大接続数は role 数に比例して増えます。
`maxConnections` と DB 側の接続上限は、datasource 本体の pool と各 role pool の合計で見積もってください。
各 role のパスワードは `passwordEnv` または `passwordFile` で供給し、YAML に平文で直書きしないでください。
`password` のような平文フィールドは datasource 本体と `roleCredentials` のどちらにも置かないでください。
読み取り専用 role の DB ユーザーには、MySQL の `FILE` 権限や PostgreSQL のテーブル作成権限を付与しないでください。
SQL 分類は第 1 層の拒否に使い、最終的な書き込み制限は DB 側の `GRANT` で保証してください。

#### 認可の既知の仕様

- `queries.viewAll` と `query.killAny` は datasource allowlist に依らず全 datasource 上の全ユーザーのクエリに及びます。運用監視用の権限であり、全 datasource を許可した管理者ロールにのみ付与してください(statement の先頭 200 文字が一覧に露出するため)。
- クエリ実行後にロールから datasource を外しても、サーバーメモリにバッファ済みの結果と CSV は TTL 内なら引き続き取得できます。即時失効が必要な場合はサーバー再起動か TTL 経過を待ってください。
- `POST /api/queries/estimate` は `query.write` を評価しません。EXPLAIN は書き込みを実行しないという前提であり、副作用のあるコネクタや UDF を追加する場合は再検証してください。
- ドキュメント共有は SQL 文の閲覧と編集権限のみを付与します。共有されたクエリや Notebook 内 SQL の実行は、実行者自身の principal と RBAC (datasource allowlist、Query Guard) で評価され、データアクセス権限は移譲されません。
- `GITHUB_GOVERNANCE=on` のガバナンスは RESULT_STORE への結果永続化とワークフローの cron 実行のみを制限します。対話クエリやワークフローの手動実行そのものは拒否せず、データアクセスの第一の防御は従来どおり RBAC と Query Guard です。

---

## 7. 認証（`AUTH_MODE=proxy`）

### 7.1 モードの違い

- **`none`（既定）**: 認証なし。principal は `TRINO_USER`。全データの所有者も `TRINO_USER`。
- **`proxy`**: oauth2-proxy などの信頼プロキシが付与する SSO ヘッダから principal を解決。
  解決した principal を**データ所有者 ID 兼 Trino 実行ユーザー**として使います。

proxy モードでは、`/api/healthz` と静的アセット以外の `/api/*` は認証必須です。ヘッダが
無い・信頼外の送信元からのアクセスは `401 { error: { code: "UNAUTHENTICATED" } }` を返します。

### 7.2 信頼境界（`AUTH_TRUSTED_PROXY_CIDRS`）

**ヘッダ偽装に対する最終防壁**です。ソケットのリモートアドレスがこの CIDR リストの外に
ある場合、SSO ヘッダは**無視**されます（= 401）。

- 既定は loopback（`127.0.0.0/8,::1/128`）。
- oauth2-proxy を **同一ホストの loopback** に置く（sidecar 構成）なら既定のままでよい。
- proxy が別ホスト・別 IP なら、その送信元 IP / CIDR を**必ず**設定してください。設定を
  誤ると、クライアントが SSO ヘッダを自分で付けて principal を偽装できてしまいます。
- Hubble 自体は `127.0.0.1` に bind し、proxy だけが到達できるようにするのが安全です。

proxy 認証は、接続元ソケットの IP が信頼 CIDR に含まれる場合に SSO ヘッダを信頼します。
したがって、信頼 CIDR 内の別プロセスは `X-Forwarded-User` などを任意に指定し、別の利用者になりすませます。

sidecar 構成では proxy と Hubble を同一 pod 内の loopback または Unix socket で接続し、信頼 CIDR を loopback に限定してください。
proxy を別ホストに置く場合は CIDR だけに依存せず、mTLS または署名付き identity assertion を併用してください。
`AUTH_TRUSTED_PROXY_CIDRS` は既定の loopback を含む必要最小限の範囲に保ってください。

### 7.3 principal の導出（`AUTH_USER_MAPPING`）

| 値                        | principal                                                     |
| ------------------------- | ------------------------------------------------------------- |
| `email-localpart`（既定） | email の `@` より前（`alice@example.com` → `alice`）          |
| `email`                   | email 全体                                                    |
| `user`                    | `AUTH_SSO_HEADER_USER`（既定 `x-forwarded-user`）の値そのまま |

`email` 系を使うときは `AUTH_SSO_HEADER_EMAIL`（既定 `x-forwarded-email`）が、`user` を
使うときは `AUTH_SSO_HEADER_USER` が、それぞれ proxy から付与されている必要があります。

#### owner ID の衝突と設定時期

既定の `email-localpart` は `@` より前だけを owner ID と Trino ユーザーに使います。
この設定では `alice@corp.example` と `alice@partner.example` が同じ `alice` になり、別人が保存リソースと Trino ユーザーを共有する可能性があります。
複数ドメインまたは外部ドメインの利用者を受け入れる環境では、メール全体を使う `AUTH_USER_MAPPING=email` を選んでください。
IdP が一意な識別子を発行できる場合は、その値を `X-Forwarded-User` に設定し、`AUTH_USER_MAPPING=user` を使う方法もあります。

owner ID は notebook、保存クエリ、alert、schedule、workflow、dashboard、履歴、共有設定の参照に使われます。
運用開始後に `AUTH_USER_MAPPING` を変更すると owner ID が変わり、既存データへ到達できなくなります。
この設定は初回利用の前に確定してください。

### 7.4 oauth2-proxy 設定例（Google provider）

`oauth2-proxy.cfg`:

```ini
provider = "google"
client_id     = "xxxxxxxx.apps.googleusercontent.com"
client_secret = "***"
# 32 バイトの cookie secret（例: openssl rand -base64 32 | head -c 32）
cookie_secret = "********************************"

email_domains = ["example.com"]

# 受け口とアップストリーム（= Hubble server）
http_address = "0.0.0.0:4180"
upstreams    = ["http://127.0.0.1:8080/"]

# 認証情報をアップストリームのヘッダへ渡す（Hubble はここから principal を解決）
pass_user_headers      = true   # X-Forwarded-User / X-Forwarded-Email
set_xauthrequest       = true
skip_provider_button   = true
reverse_proxy          = true
```

対応する Hubble 側（同一ホスト loopback / email-localpart マッピング）:

```bash
AUTH_MODE=proxy
# proxy が同一ホスト loopback なら既定の信頼 CIDR で十分
# AUTH_TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128
AUTH_USER_MAPPING=email-localpart   # X-Forwarded-Email の localpart を principal に
```

proxy を別ホストに置く場合は `AUTH_TRUSTED_PROXY_CIDRS` にその送信元を追加してください。

### 7.5 検証（oauth2-proxy なしでのヘッダ注入）

oauth2-proxy の実体が無くても、loopback（既定の信頼 CIDR 内）からヘッダを注入すれば
proxy モードの挙動を確認できます。

```bash
AUTH_MODE=proxy DB_PATH=:memory: PORT=8082 \
  pnpm --filter @hubble/server start &

# ヘッダ無し → 401（未認証）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8082/api/me            # → 401

# SSO ヘッダ注入（localhost は信頼 CIDR 内）→ principal を解決
curl -s -H 'x-forwarded-email: alice@example.com' \
        -H 'x-forwarded-user: alice' http://127.0.0.1:8082/api/me
#   {"user":"alice","authMode":"proxy","email":"alice@example.com"}

# healthz は proxy モードでも公開
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8082/api/healthz       # → 200
```

> 上記の 401 / principal 解決 / healthz 公開は実機で確認済みです。

---

## 8. Trino resource group 分離（メタデータ取得詰まり対策）

重いクエリが worker を専有しているときでも、Hubble のメタデータ取得（カタログツリー・
補完）が詰まりにくいよう、resource group を **source 別**に分けます。

### 8.1 Hubble は source を区別して送る

Hue 本体は metadata query に専用 source を付けられませんが、**Hubble は最初から
`X-Trino-Source` を 4 値で送ります**。

| `X-Trino-Source`   | 用途                                           |
| ------------------ | ---------------------------------------------- |
| `hubble`           | ユーザーが実行する通常クエリ                   |
| `hubble-metadata`  | カタログ／スキーマ／テーブル一覧・サンプル取得 |
| `hubble-download`  | 結果 CSV ダウンロードの再実行                  |
| `hubble-scheduled` | スケジュール実行（クエリスケジューラー機能）   |

（既定値。`datasources.yaml` の該当 Trino エントリの `source` / `metadataSource` /
`scheduledSource`（`hubble-download` は `source` から `<source>-download` として自動導出）で
変更可。）そのため、queryText 依存の脆い selector ではなく、**安定した `source` selector**
で分離できます。

### 8.2 file resource group manager を有効化

`etc/resource-groups.properties`:

```properties
resource-groups.configuration-manager=file
resource-groups.config-file=etc/resource-groups.json
```

### 8.3 resource group 分離（source 別）

`etc/resource-groups.json`（推奨構成の例）:

```json
{
  "rootGroups": [
    {
      "name": "global",
      "softMemoryLimit": "80%",
      "hardConcurrencyLimit": 100,
      "maxQueued": 1000,
      "schedulingPolicy": "weighted_fair",
      "subGroups": [
        {
          "name": "metadata",
          "softMemoryLimit": "5%",
          "hardConcurrencyLimit": 5,
          "maxQueued": 200,
          "schedulingWeight": 20
        },
        {
          "name": "interactive",
          "softMemoryLimit": "30%",
          "hardConcurrencyLimit": 20,
          "maxQueued": 500,
          "schedulingWeight": 10
        },
        {
          "name": "download",
          "softMemoryLimit": "30%",
          "hardConcurrencyLimit": 5,
          "maxQueued": 100,
          "schedulingWeight": 5
        },
        {
          "name": "scheduled",
          "softMemoryLimit": "20%",
          "hardConcurrencyLimit": 5,
          "maxQueued": 100,
          "schedulingWeight": 3
        },
        {
          "name": "default",
          "softMemoryLimit": "70%",
          "hardConcurrencyLimit": 50,
          "maxQueued": 500,
          "schedulingWeight": 1
        }
      ]
    }
  ],
  "selectors": [
    { "source": "hubble-metadata", "group": "global.metadata" },
    { "source": "hubble-download", "group": "global.download" },
    { "source": "hubble-scheduled", "group": "global.scheduled" },
    { "source": "hubble", "group": "global.interactive" },
    { "group": "global.default" }
  ]
}
```

ポイント：

- メタデータ用 `global.metadata` は小さな専用枠（`hardConcurrencyLimit` は 1 より大きく、
  複数ユーザー同時アクセスで詰まらないように）。
- ダウンロード再実行は重くなりやすいので `global.download` に隔離。
- `source` selector は queryText 依存より安定します。

### 8.4 巨大クエリ対策（resource group だけでは不十分な場合）

resource group は「新規クエリの開始可否・queue 選択」を制御する仕組みで、**実行中の巨大
クエリを止める仕組みではありません**。1〜2 本の巨大クエリが worker の memory/CPU を専有
すると、`global.metadata` を作ってもメタデータ取得が遅れます。次を併用してください
（`etc/config.properties`）。

```properties
# per-query メモリ上限（worker JVM heap から逆算して控えめに）
query.max-memory-per-node=4GB
query.max-memory=40GB
query.max-total-memory=60GB
memory.heap-headroom-per-node=4GB

# per-query 時間 / スキャン量上限（暴走の停止）
query.max-execution-time=2h
query.max-scan-physical-bytes=10TB

# 低メモリ時の最終安全弁
query.low-memory-killer.policy=total-reservation-on-blocked-nodes
```

heavy なバッチ系（別 source / 別ユーザー）は `hardConcurrencyLimit=1〜2` の専用 group に
隔離するのも有効です。

### 8.5 確認

重いクエリを流した状態で、Trino 上の振り分けを確認します。

```sql
SELECT query_id, state, "user", source, resource_group_id, queued_time_ms, query
FROM system.runtime.queries
WHERE source LIKE 'hubble%'
ORDER BY created DESC
LIMIT 50;
```

`source = 'hubble-metadata'` のクエリが `global.metadata` に入り、重いクエリ実行中でも
`queued_time_ms` が長時間伸びないことを確認します。

### 8.6 Hubble 側の事前ガード（Query Guard）

§8.4 の Trino ハード上限は**実行開始後**に効く最終防壁です。Query Guard は
**実行前**に `EXPLAIN (TYPE IO, FORMAT JSON)` でスキャン量を推定し、上限超過を
ユーザーに知らせる（または実行を拒否する）ソフトな防壁です。EXPLAIN はコーディネーター
のみで完結するため、追加の worker 資源を消費しません（実測 ~240ms）。

#### 仕組み

1. ユーザーがセル内での入力を止めてから 600ms 後、UI が `POST /api/queries/estimate`
   を発行します（構文エラーがなく変数が解決できる場合のみ）。
2. server が Trino に `EXPLAIN (TYPE IO, FORMAT JSON)` を投げ、各入力テーブルの
   `outputSizeInBytes` / `outputRowCount` を集計してスキャン量を推定します。
3. 推定結果と管理者設定の上限を照合し、判定（allow / warn / block）をセル下部の
   ストリップに表示します（行数・バイト数・所要時間目安・判定）。
4. `enforce` モードで block 判定のクエリは、実行ボタンが無効化されます。
   `POST /api/queries` を直接呼んでも HTTP 422 / `QUERY_BLOCKED` を返します。

#### モードの使い分け

| `QUERY_GUARD_MODE` | 挙動                                                   |
| ------------------ | ------------------------------------------------------ |
| `off`              | 推定を一切行わない                                     |
| `warn`（既定）     | 推定結果と警告を UI に表示するが、実行はブロックしない |
| `enforce`          | 上限超過クエリの実行をサーバーレベルで拒否（HTTP 422） |

導入初期は `warn` で運用し、ユーザーの反応を見てから `enforce` に切り替えるのを
推奨します。

#### `QUERY_GUARD_ON_UNKNOWN` の設計判断

統計未取得の hive テーブルや `information_schema` などは EXPLAIN でスキャン量が
推定できず「不明」になります。`block` にすると統計のないテーブルへのクエリが
すべて通らなくなるため、既定は `warn`（表示のみ）としています。
統計収集済みコネクタ（tpch / Iceberg）のみを使う環境では `block` も選択肢です。

#### §8.4 との役割分担

| 防壁                     | タイミング     | 動作                                  |
| ------------------------ | -------------- | ------------------------------------- |
| Query Guard              | 実行前（推定） | ユーザーへの早期警告 / ソフトブロック |
| Trino ハード上限（§8.4） | 実行中         | 統計不正確でもクエリを強制終了        |

両方の設定を推奨します。Guard は推定精度に依存しますが§8.4 は実測値で確実に機能します。

> **注意**: 推定精度はコネクタの統計品質に依存します。ANALYZE 未実行のテーブルや
> `system` / `information_schema` などは不明扱いになります。また所要時間の目安
> （`QUERY_GUARD_BYTES_PER_SECOND` 設定時）は概算であり、実際の実行時間とは乖離します。

---

## 9. データ管理

Hubble 自体の永続化（notebooks / saved queries / query history / audit log。クエリ対象データそのもの
ではない）は PostgreSQL（`DATABASE_URL`、**1st / production 推奨**）または SQLite
（`DB_PATH`、non-production 向け）のいずれかを選べます。**選択方法**: `DATABASE_URL` に
`postgres://` または `postgresql://` 形式の接続文字列を設定すると PostgreSQL になり、
`DB_PATH` より優先されます。`DATABASE_URL` が未設定（または空文字）のときは `DB_PATH` の
SQLite を使います。`postgres` / `postgresql` 以外のスキームは起動時エラーで停止します。
どちらを採用したかは起動ログに 1 行出力されます。

保存内容はどちらのバックエンドでも Notebook、保存クエリ、Dashboard、Workflow、Schedule、Alert、共有設定、GitHub 接続、履歴、監査証跡です。
`RESULT_STORE=none` では結果の行データは保存せず、サーバーメモリと TTL sweep だけで保持します。
`RESULT_STORE=s3` では結果の行データを S3 に保存し、DB には object key と失効時刻だけを保存します。
スキーマは `packages/server/migrations` を両バックエンドで共有し、起動時に自動適用されます（`schema_migrations` テーブルで適用管理）。

### 9.1 PostgreSQL バックエンド（主）

- **接続設定**: `DATABASE_URL=postgres://user:pass@host:5432/dbname` の形式で指定します。
  マネージド PostgreSQL（RDS / Cloud SQL 等）や既存クラスタの利用を想定しており、この
  リポジトリには PostgreSQL 本体のプロビジョニングは含まれません（docker-compose.yml は
  例外的にデモ用に同梱、[`deployment.md` §3](deployment.md#3-docker-composeデモ-trino-込み)）。
- **接続プール**: プロセスごとにプールサイズは妥当な既定（**最大 5 接続**）で固定しており、
  接続、statement、lock、transaction の期限は `DATABASE_*_TIMEOUT_MS` で変更できます。
- **プロセス数**: query registry、SSE waiter、各 worker の所有状態は共有されないため、
  PostgreSQL を使う場合も Hubble は `replicas=1` で運用します
  （[`deployment.md` §5](deployment.md#5-永続化バックエンドと-replicas-の制約)）。
- **マイグレーション**: 起動時に自動適用されます。
  advisory lock（`pg_advisory_lock`）は schema migration だけを直列化します。
  query 実行や worker を複数 process で安全にする機能ではありません。
- **バックアップ**: `pg_dump` / `pg_restore` を使ってください。

  ```bash
  pg_dump "$DATABASE_URL" -Fc -f /backup/hubble-$(date +%F).dump
  # リストアは pg_restore
  pg_restore -d "$DATABASE_URL" --clean /backup/hubble-YYYY-MM-DD.dump
  ```

- **監視観点**: 接続プールの枯渇、各 database timeout、advisory lock 待ち、migration
  失敗時の起動エラーログを監視してください。

### 9.2 SQLite（non-production 向け）

- ファイルは `DB_PATH`（既定 `./data/hubble.db`）。WAL モードのため、同じディレクトリに
  `-wal` / `-shm` の補助ファイルが生成されます。
- **同じ DB ファイルを複数プロセスで開かないこと**が前提です
  （[`deployment.md` §5](deployment.md#5-永続化バックエンドと-replicas-の制約)）。
- バックアップは稼働中ならオンラインバックアップを使うのが安全です（WAL を正しく取り込めます）。

  ```bash
  # オンライン（稼働中でも可）
  sqlite3 /var/lib/hubble/hubble.db ".backup '/backup/hubble-$(date +%F).db'"

  # あるいはサービス停止 → ファイルコピー（-wal/-shm も含めて or 停止で統合される）
  sudo systemctl stop hubble
  cp /var/lib/hubble/hubble.db /backup/
  sudo systemctl start hubble
  ```

  WAL を含む状態でファイルだけをコピーする際は、`-wal` / `-shm` も併せてコピーするか、
  `sqlite3 … ".backup"` を使ってください。

### 9.3 監査ログ

`audit_log` テーブルは、ユーザー操作とスケジュール実行を `actor`、`action`、`target`、`datasource`、`detail`、`created_at` で残す監査証跡です。
`detail` は JSON 文字列で保存され、カタログ、スキーマ、ロール、runId、trinoQueryId、エラー種別など action ごとの補足情報を保持します。

| action                  | 記録対象                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query.execute`         | ユーザーがクエリを送信し、実行レジストリに受理されたこと。                                                                                                             |
| `query.result.persist`  | クエリ結果の S3 保存成功または失敗。                                                                                                                                   |
| `csv.download`          | 結果 CSV のダウンロード要求と、必要に応じた再実行の判断。ワークフロー run 一括 (zip) 時は `target` が `workflow-run:<runId>`。                                         |
| `export.xlsx`           | 結果 XLSX のダウンロード要求と、必要に応じた再実行の判断。ワークフロー run 一括時は `target` が `workflow-run:<runId>`。                                               |
| `export.s3`             | 結果を S3 object として保存する外部エクスポート要求。                                                                                                                  |
| `export.sheets`         | 結果を Google Sheets に書き込む外部エクスポート要求。ワークフロー run 一括時は `target` が `workflow-run:<runId>`。                                                    |
| `query.cancel`          | 所有者による実行中クエリの cancel。                                                                                                                                    |
| `query.kill`            | 管理者権限による他ユーザーの実行中クエリ kill。                                                                                                                        |
| `authz.denied`          | API の認可拒否。`target` にパス、`detail` に HTTP method と error code を残す。                                                                                        |
| `config.reload`         | RBAC、datasource、または一括設定の reload 成否。失敗時は旧世代を維持した上で `outcome: "rejected"` を残す。                                                            |
| `schedule.execute`      | スケジュール実行の結果、試行回数、rowCount、Trino queryId。                                                                                                            |
| `workflow.execute`      | ワークフロー run 確定時の trigger、status、stepCounts、ステップごとの status/rowCount/errorType (SQL 文は含まない)。                                                   |
| `notification.send`     | スケジュール失敗通知のチャネル、成功、失敗、スキップ理由。                                                                                                             |
| `document.share.update` | 保存済みクエリまたはノートブックの共有設定変更 (owner のみ)。`target` は `saved_query:<id>` または `notebook:<id>`、`detail` に共有先一覧 (SQL 文は含まない)。         |
| `github.connect`        | GitHub アカウントの OAuth 接続または解除。`detail` に `action: "connect"` または `"disconnect"`。                                                                      |
| `github.push`           | ドキュメントの GitHub push。`target` は `<type>:<id>` (`saved_query` / `notebook` / `workflow`)、`detail` に repo、branch、path、commitSha (SQL 本文は含まない)。      |
| `github.pr.create`      | ドキュメントに対する PR 作成または既存 open PR の再利用。`target` は `<type>:<id>`、`detail` に branch、prNumber、prUrl (SQL 本文は含まない)。                         |
| `github.pull`           | デフォルトブランチからの取り込み (手動または定時)。`target` は `<type>:<id>`、`detail` に repo、path、commit、`trigger` (`manual` / `scheduled`、SQL 本文は含まない)。 |

拒否または失敗も、該当 action の `detail` に `outcome`、`reason`、`errorType`、`success` などを入れて記録されます。
CSV / XLSX ダウンロード再実行不能の拒否と外部エクスポート拒否は、対応する action の `outcome: "denied"` として残ります。
スケジュールの失敗または Query Guard による block は `schedule.execute` の `outcome` と `errorType` で追跡できます。

`GET /api/admin/audit-logs` は `audit.view` 権限を持つ principal だけが利用できます。
`actor`、`action`、`datasource`、`from`、`to`、`limit` を query parameter で指定し、応答の `nextCursor` を次の要求の `cursor` に渡します。
監査閲覧権限は Operations 閲覧権限から独立しているため、調査担当ロールへ必要な期間だけ付与してください。

`audit_log` は操作回数に比例して増えます。
Hubble は起動時と1日1回、`AUDIT_LOG_RETENTION_DAYS` を過ぎた行を `DATA_RETENTION_BATCH_SIZE` 件ずつ削除します。
同じ cleanup は、`ALERT_DELIVERY_RETENTION_DAYS` を過ぎた `sent` と `dead` の通知 outbox、および `QUERY_HISTORY_RETENTION_DAYS` を過ぎたクエリ履歴にも適用されます。
個別の保持日数を `0` にすると、その対象の自動削除だけを無効化できます。
クエリ履歴が未失効の S3 result を参照している間は履歴を削除せず、result expiry が参照を解除した後の cleanup で削除します。

監査ログを長期保管する場合は、保持期限より前に対象期間を CSV へエクスポートします。
エクスポートには principal、datasource、操作対象が含まれるため、アクセス制御された保管先を指定してください。

```bash
# PostgreSQL: 2026 年6月分を CSV へ出力
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "\copy (SELECT id, actor, action, target, datasource, detail, created_at FROM audit_log WHERE created_at >= '2026-06-01T00:00:00.000Z' AND created_at < '2026-07-01T00:00:00.000Z' ORDER BY created_at, id) TO '/secure/audit-2026-06.csv' WITH (FORMAT csv, HEADER true)"

# SQLite: 同じ期間を CSV へ出力
sqlite3 -header -csv /var/lib/hubble/hubble.db "
  SELECT id, actor, action, target, datasource, detail, created_at
  FROM audit_log
  WHERE created_at >= '2026-06-01T00:00:00.000Z'
    AND created_at < '2026-07-01T00:00:00.000Z'
  ORDER BY created_at, id;
" > /secure/audit-2026-06.csv
```

監査ログはインシデント調査と運用確認に使うデータなので、PostgreSQL の `pg_dump` と SQLite の `.backup` の対象から除外しないでください。

### 9.4 クエリ結果保存 S3 バックエンド

#### migration 0024 の適用確認

0024 は Parquet 派生 artifact を削除する migration ではなく、DB に残った互換列と変換ジョブテーブルを削除します。
0020 の `result_columns_json` は保持し、同じ migration で追加された `result_format` は 0024 で削除します。
0021 の `parquet_object_key` と `parquet_expires_at`、0022 の `parquet_encoding_version` と `result_parquet_conversion_jobs` は 0024 で削除します。
0023 の migration ファイルは変更せず、既存の JSONL object と `query_history.result_object_key` を保持します。
適用後は次の SQL で JSONL 参照と retention index を確認します。

```sql
SELECT id, result_object_key, result_expires_at, result_columns_json
FROM query_history
WHERE result_object_key IS NOT NULL
ORDER BY result_expires_at, id;
```

SQLite では `PRAGMA table_info(query_history)` に `result_columns_json` があり、`result_format`、`parquet_object_key`、`parquet_expires_at`、`parquet_encoding_version` がないことを確認します。
PostgreSQL では `information_schema.columns` で同じ列構成を確認します。
`result_parquet_conversion_jobs` は両方の DB から削除されます。

`RESULT_STORE=none` では、完了済みクエリの行データを `QUERY_TTL_MINUTES` のあいだサーバーメモリに保持します。
`RESULT_STORE=s3` では、正常終了したクエリの全結果を zstd レベル3の JSONL として S3 へストリーミング保存します。
JSONL の先頭行は columns メタデータで、以降は 1 行 1 record です。

JSONL が結果保存の唯一の artifact です。
rows、search、profile、export、workflow の結果読み取りは同じ JSONL を使います。
profile は `profileRowsStream` へ行を渡して列統計を計算します。
認可、所有者、datasource、期限の確認と ETag の 304 判定は、本文を読み取る前に実行します。

S3 metadata は `Content-Encoding: zstd` です。
結果保存のバックエンドは、保存、圧縮 JSONL の読み取り、削除、期限切れ削除だけを提供します。
raw byte range を結果読み取りの契約には含めません。

結果の期限切れ掃除は起動時と日次に実行します。
JSONL object の削除に成功すると、`query_history` の object key、期限、列情報を NULL に戻します。
削除に失敗した object は削除 outbox に残し、backoff 付きで再試行します。
履歴の retention prune は JSONL の参照がない行を対象にします。
Workflow の結果 object も同じ outbox で管理します。

0020 の `result_columns_json` は保持し、`result_format` は 0024 で削除します。
0021 の Parquet 参照列と 0022 の `parquet_encoding_version`、`result_parquet_conversion_jobs` は 0024 で削除します。
0023 は履歴として変更せず、JSONL 用 retention index を維持します。
0024 の適用後も JSONL object、`result_columns_json`、JSONL 用 retention index は残ります。

運用で確認する結果参照は、次の SQL で取得できます。

```sql
SELECT id, result_object_key, result_expires_at, result_columns_json
FROM query_history
WHERE result_object_key IS NOT NULL
ORDER BY result_expires_at, id;
```

pending outbox が残っている場合は、元の result store へ再接続できる設定と `s3:DeleteObject` 権限を保持してください。
`RESULT_STORE=none` へ切り替えても、既存 object は削除済みとして扱いません。
object store の lifecycle rule はアプリケーションの cleanup と同じ日数か、少し長めに設定してください。

```json
{
  "Rules": [
    {
      "ID": "expire-hubble-query-results",
      "Status": "Enabled",
      "Filter": { "Prefix": "hubble-results/" },
      "Expiration": { "Days": 8 }
    }
  ]
}
```

### 9.5 結果の外部エクスポート

結果ペインの XLSX ダウンロードと **Export** メニューは、CSV ダウンロードと同じ owner チェックと現在 role の datasource allowlist を評価します。
保存済み結果が残っている場合は保存済み object を優先し、残っていない場合は必要に応じてダウンロード用ストリームで再実行します。
再実行時は datasource に対する `query.write` と Query Guard の判定を再評価します。

XLSX ダウンロードは ExcelJS の streaming writer で workbook を返します。
Excel のワークシート上限に合わせ、ヘッダーを含めて 1,048,576 行を超える結果は HTTP 413 で拒否します。

S3 エクスポートは `RESULT_STORE_S3_*` とは独立した `EXPORT_S3_*` を使います。
CSV gzip と XLSX をサポートし、CSV 以外で gzip を要求したリクエストは拒否します。
object key はサーバー側で `<prefix>/<owner>/<queryId>-<timestamp>.<ext>` として生成され、クライアントから key を指定できません。

最小設定は次の通りです。

```bash
EXPORT_S3_BUCKET=hubble-prod-exports
EXPORT_S3_PREFIX=hubble-exports/
```

`EXPORT_S3_REGION` と `EXPORT_S3_ENDPOINT` は任意です。
`EXPORT_S3_ENDPOINT` を設定した場合は S3 互換ストレージ向けに path-style request を使います。
認証は AWS SDK の標準 credential provider chain を使います。
S3 側の最小権限は export prefix への `s3:PutObject` です。

Google Sheets エクスポートは service account の JSON ファイルを `EXPORT_SHEETS_CREDENTIALS_FILE` に指定して有効化します。
Google Cloud 側で Google Sheets API と Google Drive API を有効化してください。
Hubble は service account で spreadsheet を作成し、リクエスト principal の email に writer 権限で共有します。
proxy ヘッダーから email を解決できない principal は Google Sheets エクスポートを利用できません。
Google Sheets の 10,000,000 セル上限に余裕を持たせるため、8,000,000 セルを超える結果は拒否します。

外部エクスポートの成功と拒否は `export.s3` と `export.sheets` の監査ログで確認できます。

### 9.6 SQLite から PostgreSQL への停止移行

この移行は Hubble を停止して実施します。
SQLite と PostgreSQL を同じ Hubble から同時に更新すると、停止後に SQLite へ入った変更を PostgreSQL へ反映できません。

移行には [pgloader の SQLite 対応](https://pgloader.readthedocs.io/en/latest/ref/sqlite.html)を使います。
pgloader は SQLite の全テーブルをスキーマから列挙し、NULL と型を保ったまま PostgreSQL の既存テーブルへ COPY できます。

#### 移行対象

現在の application table は次の16表です。
移行コマンドはこの固定リストを入力にせず、SQLite と PostgreSQL のスキーマから対象表を列挙します。

| 分類                    | テーブル                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| Notebook とクエリ       | `notebooks`, `saved_queries`, `query_history`, `dashboards`                      |
| Schedule と workflow    | `schedules`, `schedule_runs`, `workflows`, `workflow_runs`, `workflow_step_runs` |
| Alert                   | `alerts`, `alert_deliveries`                                                     |
| 共有と GitHub 連携      | `document_shares`, `github_connections`, `document_git_links`                    |
| 監査と object lifecycle | `audit_log`, `result_object_deletions`                                           |

`schema_migrations` は移行対象から除外します。
移行先には同じ Hubble release の migration を先に適用し、移行元と移行先の migration version が一致することを確認します。

現在の application table は TEXT または複合主キーを使うため、application sequence を持ちません。
この手順は sequence が0件である現行 schema を対象にします。
将来 application sequence を追加する release では、対応する table と column を特定して `setval` する手順を追加してから移行します。

#### 事前条件

1. 移行元と移行先で同じ Hubble release を使います。
2. 移行先には専用の空 PostgreSQL database を用意します。
3. `GITHUB_TOKEN_ENCRYPTION_KEY`、`GITHUB_TOKEN_ENCRYPTION_KEY_ID`、`GITHUB_TOKEN_ENCRYPTION_KEYRING` を移行前後で同じ値に保管します。
4. `RESULT_STORE`, `RESULT_STORE_TTL_DAYS`, `RESULT_STORE_S3_BUCKET`, `RESULT_STORE_S3_PREFIX`, `RESULT_STORE_S3_REGION`, `RESULT_STORE_S3_ENDPOINT` を記録し、移行先へ同じ値を設定します。
5. 移行先から同じ object への write、read、delete ができる credential と IAM policy を用意します。
6. 認証 mode と user mapping を記録します。

`github_connections` の token は暗号文のまま移行されます。
active暗号鍵を変更する場合は、旧鍵を `GITHUB_TOKEN_ENCRYPTION_KEYRING` に残します。
旧 key ID を持つ現行 v1 暗号文は、接続利用時に active key へ遅延再暗号化されます。
旧鍵をkeyringから削除する前に、長期間利用されていないGitHub接続を含めて再暗号化または再接続を完了してください。

`query_history` の `result_object_key`、`result_expires_at`、`result_columns_json` が現行の JSONL 結果参照です。
0020 の `result_format`、0021 の Parquet 参照列、0022 の `parquet_encoding_version` と変換ジョブテーブルは、0024 で削除されます。
0020 の `result_columns_json` と 0023 の JSONL 用 retention index は、0024 の適用後も残ります。
0024 は既存行や JSONL object を削除せず、JSONL 用 retention index を維持します。
`workflow_step_runs` の `result_object_key` は従来どおり workflow step の参照です。
database 移行と object store の変更は同時に行いません。
移行先は旧環境と同じ object store を使い、`result_object_deletions` が空になるまで設定と delete 権限を維持します。
object store の変更は database 移行の完了後に別の作業として実施してください。

#### 移行元の停止とバックアップ

移行日より前に、稼働中の SQLite backend を移行先と同じ Hubble release へ更新します。
正常起動を確認し、`schema_migrations` にその release の全 migration が記録されていることを確認します。
移行のためだけに別の Hubble process を同じ SQLite file へ接続しません。

Hubble を停止した後は、移行完了まで SQLite を使う Hubble を起動しません。
停止後に backup と checksum を作成します。

```bash
sqlite3 /var/lib/hubble/hubble.db ".backup '/var/backups/hubble-migration.db'"
sha256sum /var/backups/hubble-migration.db > /var/backups/hubble-migration.db.sha256
sqlite3 /var/backups/hubble-migration.db 'PRAGMA integrity_check;'
```

`PRAGMA integrity_check` の出力が `ok` でない場合は移行を開始しません。

#### 移行先スキーマの作成

専用の空 PostgreSQL database に同じ release の Hubble を接続し、migration 完了後に Hubble を停止します。
この起動も利用者の request を受けない maintenance 環境で行います。

移行元と移行先の migration version を比較します。

```bash
sqlite3 -noheader /var/backups/hubble-migration.db \
  "SELECT version || '|' || name FROM schema_migrations ORDER BY version" \
  > /tmp/hubble-sqlite-migrations.txt

psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT version || '|' || name FROM schema_migrations ORDER BY version" \
  > /tmp/hubble-postgres-migrations.txt

diff -u /tmp/hubble-sqlite-migrations.txt /tmp/hubble-postgres-migrations.txt
```

`diff` に差がある場合は Hubble の release または migration 適用状態が一致していません。
その状態では data copy を開始しません。

次に、全 application table と列順を schema から生成して比較します。

```bash
sqlite3 -noheader /var/backups/hubble-migration.db "
  SELECT m.name || '|' || p.cid || '|' || p.name
  FROM sqlite_schema AS m, pragma_table_info(m.name) AS p
  WHERE m.type = 'table'
    AND m.name NOT LIKE 'sqlite_%'
    AND m.name <> 'schema_migrations'
  ORDER BY m.name, p.cid
" > /tmp/hubble-sqlite-columns.txt

psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "
  SELECT table_name || '|' || (ordinal_position - 1) || '|' || column_name
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name <> 'schema_migrations'
  ORDER BY table_name, ordinal_position
" > /tmp/hubble-postgres-columns.txt

diff -u /tmp/hubble-sqlite-columns.txt /tmp/hubble-postgres-columns.txt
```

`diff` が空であることを確認します。
この比較により、将来 table が追加された場合も手順書の固定リストだけに依存せず欠落を検出できます。

移行先の application table がすべて空であることも確認します。

```bash
psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 <<'SQL'
SELECT format(
  'SELECT %L || ''|'' || count(*) FROM %I.%I;',
  tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = current_schema()
  AND tablename <> 'schema_migrations'
ORDER BY tablename
\gexec
SQL
```

全行が `<table>|0` でなければ、別の空 database を作り直します。
既存 data に追加する方式は、主キー衝突と重複実行を区別できないためサポートしません。

#### pgloader による data copy

接続情報を環境変数から展開する load file を作成します。
PostgreSQL の password は `PGPASSWORD` または permission を `0600` にした `PGPASSFILE` で渡せます。

```text
LOAD DATABASE
     FROM '{{HUBBLE_SQLITE_URL}}'
     INTO '{{HUBBLE_POSTGRES_URL}}'
 WITH data only
 EXCLUDING TABLE NAMES LIKE 'schema_migrations'
;
```

load file を `/tmp/hubble-sqlite-to-postgres.load` に保存し、絶対パスを指定して実行します。

```bash
export HUBBLE_SQLITE_URL='sqlite:///var/backups/hubble-migration.db'
export HUBBLE_POSTGRES_URL='postgresql://hubble@postgres.internal:5432/hubble'
export PGPASSFILE=/run/secrets/hubble-pgpass

pgloader --on-error-stop /tmp/hubble-sqlite-to-postgres.load
```

pgloader が reject または error を報告した場合は、その PostgreSQL database を破棄してから再実行します。
途中まで COPY された database に同じ処理を重ねません。

#### 件数と外部 object 参照の検証

application table ごとの件数を両 database から生成します。

```bash
sqlite3 -noheader /var/backups/hubble-migration.db \
  "SELECT name FROM sqlite_schema
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
   ORDER BY name" |
while IFS= read -r table; do
  count=$(sqlite3 -noheader /var/backups/hubble-migration.db \
    "SELECT count(*) FROM \"$table\"")
  printf '%s|%s\n' "$table" "$count"
done > /tmp/hubble-sqlite-counts.txt

psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 <<'SQL' \
  > /tmp/hubble-postgres-counts.txt
SELECT format(
  'SELECT %L || ''|'' || count(*) FROM %I.%I;',
  tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = current_schema()
  AND tablename <> 'schema_migrations'
ORDER BY tablename
\gexec
SQL

diff -u /tmp/hubble-sqlite-counts.txt /tmp/hubble-postgres-counts.txt
```

件数だけでは object key の取り違えを検出できないため、live reference と削除待ち key を別々に比較します。

```bash
sqlite3 -noheader /var/backups/hubble-migration.db "
  SELECT result_object_key FROM query_history WHERE result_object_key IS NOT NULL
  UNION ALL
  SELECT result_object_key FROM workflow_step_runs WHERE result_object_key IS NOT NULL
  ORDER BY 1
" > /tmp/hubble-sqlite-live-object-keys.txt

psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "
  SELECT result_object_key FROM query_history WHERE result_object_key IS NOT NULL
  UNION ALL
  SELECT result_object_key FROM workflow_step_runs WHERE result_object_key IS NOT NULL
  ORDER BY 1
" > /tmp/hubble-postgres-live-object-keys.txt

sqlite3 -noheader /var/backups/hubble-migration.db \
  "SELECT object_key FROM result_object_deletions ORDER BY object_key" \
  > /tmp/hubble-sqlite-deletion-keys.txt

psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT object_key FROM result_object_deletions ORDER BY object_key" \
  > /tmp/hubble-postgres-deletion-keys.txt

diff -u /tmp/hubble-sqlite-live-object-keys.txt /tmp/hubble-postgres-live-object-keys.txt
diff -u /tmp/hubble-sqlite-deletion-keys.txt /tmp/hubble-postgres-deletion-keys.txt
```

live reference の参照先 object が存在することも確認します。
`result_object_deletions` の key は削除待ちなので、この存在確認には含めません。
S3 互換 endpoint を使う場合は `aws s3api` に同じ endpoint を指定してください。

```bash
while IFS= read -r key; do
  aws s3api head-object \
    --bucket "$RESULT_STORE_S3_BUCKET" \
    --key "$key" >/dev/null || printf '%s\n' "$key"
done < /tmp/hubble-postgres-live-object-keys.txt > /tmp/hubble-missing-object-keys.txt

test ! -s /tmp/hubble-missing-object-keys.txt
```

新規構築時から `RESULT_STORE=none` で運用してきた環境では、live reference と削除待ち key の両方が空であることを確認します。
どちらかに key がある場合は `RESULT_STORE=none` へ切り替えず、元の object store 設定を維持してください。
削除待ち key が残った状態で store を無効にすると、Hubble は job を保持しますが object を削除できません。

PostgreSQL sequence の有無も記録します。
現在の schema では結果が0行になる想定です。

```bash
psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "
  SELECT sequence_schema || '.' || sequence_name
  FROM information_schema.sequences
  WHERE sequence_schema = current_schema()
  ORDER BY sequence_name
"
```

data copy 後の移行先 Hubble を初めて起動すると、利用者 request の有無にかかわらず schedule、workflow、alert、alert delivery、result expiry、result deletion の worker が動き始めます。
alert 配信や object 削除などの外部副作用を止める maintenance mode はありません。
そのため、data が入った移行先の初回起動を cutover 境界とし、旧 SQLite backend が停止していることを再確認してから起動します。
Service や ingress から隔離するだけでは worker の副作用を防げません。

移行先を起動したら直ちに traffic を切り替え、次を確認します。

1. migration error がなく `/api/healthz` と `/api/readyz` が成功すること。
2. owner ごとの Notebook、保存クエリ、Dashboard、Workflow、Schedule、Alert が表示されること。
3. 共有設定と GitHub 接続が復号できること。
4. query history と workflow step の保存済み result を取得できること。
5. pending の alert delivery と result object deletion が想定した件数であること。

旧 SQLite file と checksum は監査用 backup として変更せず保管します。

data copy と SQL による検証までに失敗した場合は移行先 database を破棄し、旧 `DB_PATH` と旧設定で SQLite backend を再開できます。
data が入った移行先 Hubble を一度でも起動した後は、traffic が未到達でも worker が PostgreSQL、通知先、object store を変更し得るため、旧 SQLite への単純復帰を行いません。
初回起動後に戻す必要がある場合は受付と全 worker を停止し、PostgreSQL 側の差分と外部副作用を調査したうえで、差分を SQLite へ反映するか、最新 PostgreSQL backup から別環境へ移行してから再開します。
旧 SQLite と移行先 PostgreSQL を同時に稼働させません。

### 9.7 none → proxy 切替時の owner backfill

`owner` カラムは migration `0002` で追加され、既存行は空文字で入ります。起動時に**空の
owner を `TRINO_USER` で埋めます**（`backfillOwners`、冪等）。両バックエンドで共通の挙動です。

注意点：

- `none` モードで作った既存の Notebook・保存クエリ・履歴は、**すべて `TRINO_USER` の
  所有**になります。proxy へ切り替えても、それらは個々のエンドユーザーには見えません
  （`TRINO_USER` の principal だけが見える）。
- proxy 切替前に `TRINO_USER` を、移行後も意味のある値（例: 管理者アカウント）にしておくと
  扱いやすいです。
- 共有（他ユーザーへの公開）は非対応です。

---

## 10. チューニング

| 変数                             | 意味                                   | 目安                                                                                      |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `QUERY_MAX_ROWS`                 | 1 クエリでメモリにバッファする行数上限 | 大きいほどメモリ消費増。既定 100k。画面表示は上限まで、超過分は truncated 表示            |
| `QUERY_CONCURRENCY`              | 同時に追走するクエリ数                 | サーバーの CPU、メモリ、Trino 同時実行枠から決定。既定 5                                  |
| `QUERY_MAX_QUEUED`               | 実行枠を待つクエリの全体上限           | 短時間の集中を吸収できる件数にする。上限到達時は HTTP 429。既定 100                       |
| `QUERY_MAX_QUEUED_PER_PRINCIPAL` | principal ごとの待機上限               | 一人の集中実行が待機枠を占有しない値にする。上限到達時は HTTP 429。既定 20                |
| `QUERY_MAX_TRACKED`              | registry が保持するクエリの上限        | `QUERY_TTL_MINUTES` と完了頻度から決定。期限切れを掃除しても上限なら HTTP 429。既定 10000 |
| `QUERY_TTL_MINUTES`              | 完了クエリの保持時間                   | 長いほど再接続でスナップショットを取り戻しやすいがメモリ占有。既定 30 分                  |
| `METADATA_TTL_SECONDS`           | メタデータキャッシュ TTL               | 短いほど鮮度が上がるが Trino へのメタデータ問い合わせが増える。既定 300 秒                |
| `QUERY_OVERFLOW_MODE`            | 上限超過時                             | `truncate`（既定, 打ち切り）/ `cancel`（クエリ中止）                                      |
| `RESULT_STORE_TTL_DAYS`          | 保存済み結果の保持日数                 | S3 lifecycle rule は同じ日数か少し長めに設定。既定 7 日                                   |

大結果のダウンロードについて：画面のグリッドは `QUERY_MAX_ROWS` で打ち切られますが、
`RESULT_STORE=s3` で保存済み結果が残っている場合は保存済み object から全件を流します。
保存済み結果が無い場合、CSV ダウンロードは別ストリームで実行されます。
バッファが truncated だった場合はダウンロード用にクエリを再実行しながら（`source=hubble-download`）全件を流すため、画面の上限とは独立に全件取得できます。
再実行コストがかかる点と、resource group の `download` 枠（[§8.3](#83-resource-group-分離source-別)）に注意してください。

---

## 11. トラブルシューティング

| 症状                                        | 主な原因と対処                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Trino 接続失敗 / 5xx**                    | `datasources.yaml` の該当エントリの `baseUrl` の到達性、Basic auth（`username`/`passwordEnv`                                                                                                                                                                                           | `passwordFile`）、HTTPS 要否を確認。`curl -u user:pass <baseUrl>/v1/info` で疎通確認 |
| **401 UNAUTHENTICATED**（proxy）            | SSO ヘッダが付いているか、送信元が `AUTH_TRUSTED_PROXY_CIDRS` 内か、`AUTH_USER_MAPPING` と実際のヘッダ（user/email）が整合しているかを確認                                                                                                                                             |
| **impersonation 拒否**                      | Trino のエラーに `Cannot impersonate` 等が出る。`etc/rules.json` の `impersonation` ルールで `original_user`（= `datasources.yaml` の `username`）→ `new_user`（principal）が許可されているか確認                                                                                      |
| **ポート競合**                              | `EADDRINUSE`。`PORT` を変更、または `ss -ltnp \| grep :8080` で占有プロセスを確認                                                                                                                                                                                                      |
| **DB ロック / busy**                        | 複数の server プロセスが同じ `DB_PATH` を開いていないか確認（単一プロセス前提）。WAL の `-wal`/`-shm` 残骸はプロセス停止後に統合される                                                                                                                                                 |
| **静的配信されない**                        | 起動ログに `serving static web app from …` が出ているか、`STATIC_DIR` が `index.html` を含むディレクトリ（= `web build` 済み）を指しているかを確認                                                                                                                                     |
| **メタデータが古い / 詰まる**               | Data パネルの更新ボタンか `POST /api/metadata/refresh`。詰まりは [§8](#8-trino-resource-group-分離メタデータ取得詰まり対策) の resource group 分離で緩和                                                                                                                               |
| **クエリが `QUERY_BLOCKED` で実行できない** | `QUERY_GUARD_MODE=enforce` のとき、スキャン推定値が上限（`QUERY_GUARD_MAX_SCAN_BYTES` / `QUERY_GUARD_MAX_SCAN_ROWS`）を超過するとブロックされます。`GET /api/config` の `guard` ブロックで現在の設定値を確認し、上限の引き上げ・`mode=warn` への変更・LIMIT 追加などで対処してください |
| **スケジュールが実行されない**              | スケジュール自体の `enabled` フラグ・`SCHEDULER_ENABLED` 環境変数（`false` でループ停止）・cron 式の書式（サーバーのローカル TZ で評価される 5 フィールド形式）・サーバープロセスの TZ 設定を確認してください                                                                          |

ログは systemd 運用なら `journalctl -u hubble -f` で確認できます。

---

## 12. クエリスケジューラー

保存した SQL を定期自動実行する機能です。アシストサイドバーの **Schedules** パネルから
スケジュールを作成・管理します。

### 仕組み（tick / cron / TZ）

スケジューラーは server プロセス内で動作します。`SCHEDULER_TICK_SECONDS`（既定 15 秒）ごとに
due なスケジュールをスキャンし、5 フィールド cron 式（分 時 日 月 曜日）をサーバーの
ローカル時刻で評価して発火します。同一スケジュールのオーバーラップはなく、前の実行が
終わっていなければ次の発火はスキップされます。
`SCHEDULER_MAX_CONCURRENT`（既定 2）は、schedule、workflow の各 step、alert が共有する statement 同時実行上限です。

Hubble 全体を **replicas=1** で運用します。
`SCHEDULER_ENABLED=false` で他 Pod の tick だけを止めても、API の query registry と SSE waiter は共有されないため、複数 replica を安全にはできません。
ワークフローの cron 実行もスケジュールと同じ `SCHEDULER_*` 環境変数 (tick 間隔、同時実行上限など) を共有します。

### 構文検証とリトライの動作

SQL の構文は 2 段階で検証されます。

- **クライアント側**（作成・編集フォーム）: ANTLR パーサーがリアルタイムで構文エラーを
  検出します。エラーがある状態では保存できません。
- **サーバー側**: スケジュールの登録・更新時、および各実行直前に Trino の
  `EXPLAIN (TYPE VALIDATE)` で構文・意味エラーを検証します。USER_ERROR（構文エラー、
  テーブル不存在など）は実行されず `failed` として記録されます（リトライなし）。
  Query Guard（enforce モード）による block は `blocked` として記録され、同様にリトライなしです。

**自動リトライ**は Trino 接続障害や USER_ERROR 以外の失敗が対象です。スケジュールごとに
リトライポリシーを設定できます。

| 項目                | 範囲    | 既定値 |
| ------------------- | ------- | ------ |
| `maxAttempts`       | 1〜10   | 3      |
| `backoffSeconds`    | 1〜3600 | 60     |
| `backoffMultiplier` | 1〜10   | 2      |

バックオフは幾何級数（例: 60s → 120s → 240s）で増加します。

### 逃した発火のスキップ

停止中（`SCHEDULER_ENABLED=false` / プロセス停止）に本来発火するはずだった実行は
スキップされます。再起動時は現在時刻を基準に次回発火時刻を再計算するため、
「溜まった分をまとめて実行する」ことはありません。

### 実行と履歴の保持

実行はスケジュールの所有者 principal（`X-Trino-User`）で行われ、`X-Trino-Source` に
`hubble-scheduled`（`datasources.yaml` の該当 Trino エントリの `scheduledSource` で変更可）
を付与します。
ロール解決は、スケジュールの作成/更新時に保存された principal スナップショット（user、email、groups）を使います。
作成/更新時点で email や groups が解決されていれば、email 系 assignment と `group` assignment はスケジュール実行にも適用されます。
`principal_snapshot` がない、または検証に失敗した歴史的なレコードは実行対象にせず、`PRINCIPAL_SNAPSHOT_REQUIRED` として blocked にします。
owner 文字列から実行時 principal を復元しないため、必要な場合は principal snapshot を持つ定義を作成し直します。
owner がスケジュールを再保存すると、その時点の principal でスナップショットが更新されます。
workflow と alert も同じ扱いで、作成時 snapshot を保持し、欠損または不正な snapshot の実行を拒否します。
**結果の行データは
保存されません**（完了ステータス・試行回数・rowCount・elapsedMs・trinoQueryId・エラーのみ
記録）。履歴はスケジュールごとに直近 `SCHEDULER_RUNS_RETENTION`（既定 50）件を保持し、
それを超えた古い行は自動でプルーンされます。

### 失敗通知

スケジュール編集フォームで **Failure notifications** を有効にすると、run が `failed` として確定した後に Slack または email へ通知できます。
成功時、リトライ待ち、リトライ後の成功、Query Guard の `blocked` では通知しません。
通知本文にはスケジュール名、datasource、owner、失敗理由、実行時刻を含めます。
失敗理由はエラーメッセージの先頭 500 文字までです。
SQL 全文は通知に含めません。
通知送信に失敗してもスケジューラー本体は失敗せず、warn ログと `notification.send` 監査ログに結果を残します。

Slack は `NOTIFY_SLACK_WEBHOOK_URL` に incoming webhook URL を設定します。
Slack の incoming webhook は Slack Developer Docs の [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) を参照して、Slack app で Incoming Webhooks を有効化し、投稿先チャンネルを選んで URL を作成します。
webhook URL は secret として扱い、Git に保存しないでください。

SMTP の設定例です。

```bash
NOTIFY_SMTP_HOST=smtp.example.com
NOTIFY_SMTP_PORT=587
NOTIFY_SMTP_USER=hubble
NOTIFY_SMTP_PASSWORD_ENV=SMTP_PASSWORD
SMTP_PASSWORD=change-me
NOTIFY_SMTP_FROM=hubble@example.com
```

`NOTIFY_SMTP_PORT=465` の場合は implicit TLS で接続します。
それ以外のポートでは SMTP サーバーが STARTTLS を広告した場合に TLS へ昇格します。

### スケジューラーの無効化

`SCHEDULER_ENABLED=false` でスケジューラーの tick ループを停止できます。この場合、
API（スケジュールの登録・閲覧・手動実行エンドポイント）は引き続き利用可能です。
手動実行（`POST /api/schedules/:id/run`）はこの設定に関わらず機能します。

---

## 13. GitHub 連携

保存クエリ、ノートブック、ワークフローを GitHub リポジトリへ push し、PR 経由でレビューと
承認を行う機能です。利用者向けの操作手順は [`user-guide.md`](user-guide.md) §13 を参照してください。

### 有効化

`GITHUB_REPO=owner/repo` を設定すると機能が有効になります。未設定のときは GitHub 関連 API は
404 (`GITHUB_DISABLED`) を返し、UI からも連携コントロールは非表示です。

`GITHUB_REPO` を設定した場合、次も必須です。欠けると起動時にエラーで停止します。

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_TOKEN_ENCRYPTION_KEY` (base64 エンコードされた 32 バイト。`openssl rand -base64 32`)

接続先は **GitHub.com** のみです (GitHub Enterprise Server は対象外)。

### GitHub App のセットアップ

1. [GitHub](https://github.com/) で **New GitHub App** を作成する。
2. **Callback URL** を `https://<hubble-host>/api/github/callback` に設定する
   (ローカル開発では `http://localhost:8080/api/github/callback` など、Hubble の公開 URL に合わせる)。
3. **Repository permissions** に次を付与する。
   - **Contents**: Read and write
   - **Pull requests**: Read and write
4. App を作成し、**Client ID** と **Client secret** を Hubble の環境変数へ設定する。
5. 対象リポジトリ (`GITHUB_REPO` で指定した repo) に App を **Install** する。
6. Hubble 側に `GITHUB_TOKEN_ENCRYPTION_KEY` を設定する (`openssl rand -base64 32` の出力をそのまま使う)。

ユーザーは OAuth web フローで各自の GitHub アカウントを Hubble に接続します。取得した
アクセストークンは AES-256-GCM で暗号化して DB に保存します。

### token暗号鍵のローテーション

新規暗号文は `v1.<key-id>.<iv>.<ciphertext>.<tag>` 形式で保存します。
AES-256-GCM 鍵は設定した master key から HKDF で token 暗号化用途へ分離します。
旧 `iv.ciphertext.tag` 形式も復号できるため、既存接続を一括停止せずに移行できます。

1. 現在の `GITHUB_TOKEN_ENCRYPTION_KEY` と key ID を `GITHUB_TOKEN_ENCRYPTION_KEYRING` へ追加する。
2. 新しい32バイト鍵を `GITHUB_TOKEN_ENCRYPTION_KEY` に設定し、新しい `GITHUB_TOKEN_ENCRYPTION_KEY_ID` を設定する。
3. Hubble を再起動し、GitHub 接続が利用されるたびに active key へ再暗号化されることを確認する。
4. 未利用接続の再接続または計画的な再暗号化が完了した後、旧鍵を keyring から削除する。

### ブランチ保護の推奨

Hubble は feature ブランチ (`hubble/<user>/<type>-<id>`) への push のみを行い、デフォルト
ブランチへの直接 push はしません。必須レビューは GitHub 側の **branch protection** に委譲します。

デフォルトブランチ (`GITHUB_DEFAULT_BRANCH`、既定 `main`) に、少なくとも次を設定することを
推奨します。

- 直接 push の禁止、または PR 経由のみ許可
- レビュー必須 (Required pull request reviews)
- 必要に応じて status check や signed commit など組織ポリシーに合わせたルール

### データ取扱い上の注意

push される SQL 本文にはリテラル値 (定数) が含まれることがあります。`GITHUB_REPO` で指定する
リポジトリの可視性とアクセス権は、組織のデータ取扱い基準に合わせてください。private リポジトリ
の利用を検討し、監査ログ (`github.push` / `github.pr.create`) で操作者と対象ドキュメントを
追跡できます。

### ガバナンス強制 (`GITHUB_GOVERNANCE=on`)

`GITHUB_REPO` が設定されている環境で `GITHUB_GOVERNANCE=on` にすると、GitHub 承認と
RESULT_STORE 永続化、ワークフローの cron 実行が連動します。利用者向けの操作と承認手順は
[`user-guide.md`](user-guide.md) §13 を参照してください。

#### 結果永続化の制限 (対話クエリ)

`RESULT_STORE=s3` でも、対話クエリ (Notebook セル、保存クエリの Insert/New cell、履歴からの
再実行を含む `POST /api/queries`) は、ステートメント文字列 (末尾空白を除く完全一致) が
次のいずれかに含まれる場合のみ S3 へ永続化されます。

- 承認済み保存クエリの `statement`
- 承認済みノートブックの SQL セル `source`
- 承認済みワークフローの各ステップ `statement`

一致しないクエリも **実行自体は可能** です。メモリ上の結果表示と `QUERY_TTL_MINUTES` 内の
CSV ダウンロードは従来どおりです。履歴の **Open result** や期限を過ぎた CSV 再取得で
S3 保存済み結果に依存する経路だけが効きません。

承認済み集合は 60 秒キャッシュされます。ドキュメントの編集や PR マージ後の承認反映まで
最大 60 秒の遅延があるため、マージ直後に永続化を確認するときは少し待つか、同期モーダルで
バッジが **approved** になってから試してください。

#### ワークフロー

- **cron 実行**: ワークフロー全体が GitHub 上で承認済み (`approved_hash` とローカル正規形
  ハッシュが一致) でない場合、発火時に SQL は実行されず、run 全体が `blocked` として記録
  されます (全ステップ `skipped`)。
- **手動実行**: 未承認でも実行できますが、ステップ結果は RESULT_STORE へ永続化されません
  (メモリ上の run 表示と TTL 内の CSV 相当の挙動は従来どおり)。

#### 承認判定と既知の制限

- 実行時の承認判定は、DB にキャッシュされた `approved_hash` とローカル内容のハッシュ比較のみ
  です。ガバナンス判定のたびに GitHub API は呼びません (`GITHUB_STATUS_TTL_SECONDS` は
  バッジ表示用の別キャッシュです)。
- ノートブックの `${var}` を置換した後のステートメントは、承認済み集合の原文と一致しない
  ため永続化されません。
- 単発スケジュール (`/api/schedules`、docs/user-guide.md §11) はガバナンス対象外です。

### main からの取り込み (フェーズ 3)

デフォルトブランチ (`GITHUB_DEFAULT_BRANCH`、既定 `main`) 上の承認済み内容を Hubble へ
取り込む経路は **定時同期** と **手動取り込み** の 2 つです。利用者向けの GUI 操作は
[`user-guide.md`](user-guide.md) §13.6 を参照してください。

#### 定時同期 (夜間バッチ)

`GITHUB_SYNC_CRON` (既定 `0 3 * * *`) に従い、server プロセス内のスケジューラが
全リンク済みドキュメントを走査します。評価はクエリスケジューラーと同じ 5 フィールド cron
式とサーバーのローカル TZ です。`off` にすると定時同期は起動しません。

取り込み対象は、ローカル内容の正規形ハッシュが `approved_hash` (最後に承認された内容) と
一致しているリンクのみです (fast-forward 相当)。main 側が進んでいればローカルを更新し、
リンク行の `approved_hash` なども main の最新に合わせます。次の場合は **上書きせず
スキップ** します (安全側)。

- ローカルが最後の承認内容から変更されている (`skippedModified`)
- 一度も承認されていない (`skippedUnapproved`)
- main 上のファイルが見つからない、またはパースに失敗した

読み取りトークンの解決順は次のとおりです。

1. `GITHUB_SYNC_TOKEN` が設定されていればそれを使う (全 owner 共通)
2. 無ければ各ドキュメント **owner** の GitHub 接続トークン
3. どちらも無い、または owner トークンが期限切れで refresh できない場合はそのドキュメントを
   スキップ (`skippedNoToken`)

監査ログには `github.pull` が `trigger: scheduled` で記録されます。1 回の走査の末尾に
`updated` / `skippedModified` / `skippedNoToken` / `failed` の件数が info ログに出ます。

定時同期も server process 内に cron timer を持つため、H11 の単一 replica 制約に従います。
定時取り込みを使わない場合は `GITHUB_SYNC_CRON=off` で無効化できます。

#### 手動取り込み (API / GUI)

`POST /api/github/documents/:type/:id/pull` (type は `saved_query` / `notebook` /
`workflow`) で、owner がローカル編集を破棄して main の承認済み内容へ強制復元できます。
GitHub 同期モーダルの **Revert to main** (2 段階確認) からも同じ API を呼びます。
取り込み後のステータスは **approved** になり、監査には `trigger: manual` が残ります。

#### 取り込み時のデータ上の注意

- ノートブックのセル id は再採番されます (正規形にセル id を含めないため)。
- 保存クエリの `isFavorite` とワークフローの `enabled` はローカル値を維持します。

---

## 14. AI アシスタント

`AI_PROVIDER` を設定すると、SQL の説明、エラー修正、下書き、書き換えを行う
AI アシスタント（`POST /api/ai/assist`、SSE ストリーム）が有効になります。
既定は `off` で、その場合 API は HTTP 501 を返し、UI にも入口を表示しません。

### 14.1 有効化

```bash
# Gemini API を使う場合
AI_PROVIDER=gemini-api
GEMINI_API_KEY=...            # AI_API_KEY_ENV で読み先の変数名を変更可能
# AI_MODEL=gemini-2.5-flash   # 既定値

# GitHub Models を使う場合
AI_PROVIDER=github-models
GITHUB_MODELS_TOKEN=...       # models:read 権限の PAT
# AI_MODEL=openai/gpt-4o-mini # 既定値
```

環境変数の詳細は [§4](#4-環境変数リファレンス) を参照してください。

### 14.2 権限

利用には RBAC permission `ai.use` が必要です（`rbac.yaml.example` 参照）。
`rbac.yaml` が無い環境では組み込みロール `unrestricted` が `ai.use` を含むため、
provider を有効化すると全ユーザーが利用できます。加えてリクエスト対象の
datasource に対する allowlist チェックも通常クエリと同様に適用されます。

### 14.3 データの扱い

- prompt には対象 SQL、エラーメッセージ、ユーザーが明示的に指定したテーブルの
  スキーマ（列名と型）が含まれ、外部の LLM provider へ送信されます。
  テーブルの**データ本体は送信されません**。
- 監査ログ（action: `ai.assist`）には task 種別、provider、モデル名、成否、
  応答文字数、SQL のハッシュのみを記録し、prompt 本文と応答本文は保存しません。
- AI が提案した SQL は自動実行されません。利用者が diff を確認して適用し、
  実行時には通常の RBAC と Query Guard がそのまま適用されます。

---

## 15. 関連ドキュメント

- 利用者向け操作: [`user-guide.md`](user-guide.md)
- Docker / Compose / Kubernetes デプロイ: [`deployment.md`](deployment.md)

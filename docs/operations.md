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
  db[("永続化 DB\nPostgreSQL(主) / SQLite(代替)\nnotebooks / saved_queries / query_history")]

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
| `DATABASE_URL`                    | （未設定 = SQLite を使用）        | `postgres://` / `postgresql://` 形式の接続文字列（1st/production 推奨）。設定すると永続化バックエンドが PostgreSQL になり `DB_PATH` より優先されます。それ以外のスキームは起動時エラー（[§9.1](#91-postgresql-バックエンド主)） |
| `DB_PATH`                         | `./data/hubble.db`                | SQLite ファイルパス（non-production 向け。`DATABASE_URL` 未設定時のみ使用）。`:memory:` で揮発（テスト用）                                                                                                                      |
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
| `QUERY_TTL_MINUTES`               | `30`                              | 完了クエリを保持してから sweep するまでの分数                                                                                                                                                                                   |
| `QUERY_OVERFLOW_MODE`             | `truncate`                        | `QUERY_MAX_ROWS` 超過時の挙動（`truncate` = 打ち切り / `cancel` = 中止）                                                                                                                                                        |
| `METADATA_TTL_SECONDS`            | `300`                             | メタデータキャッシュの TTL（秒）                                                                                                                                                                                                |
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
| `SCHEDULER_MAX_CONCURRENT`        | `2`                               | スケジューラー全体で同時実行できるスケジュール数の上限                                                                                                                                                                          |
| `SCHEDULER_RUNS_RETENTION`        | `50`                              | スケジュールごとに保持する実行履歴の上限行数（古い行はプルーン）                                                                                                                                                                |

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

MySQL/PostgreSQL データソースは `datasources.yaml` の単一 credential で接続するため、
メタデータ取得でも principal は DB 側へ伝播しません（全ユーザーが同一 DB ユーザーとして
見えます）。shared credential は DB 側へ principal が伝播しないため、Hubble 側では
`rbac.yaml` の `role.datasources` で露出する datasource id を allowlist 制限してください。
未指定のロールは後方互換のため全 datasource を利用できます。拒否時は datasource の存在有無を
漏らさないよう HTTP 404 として応答します。

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

### 7.3 principal の導出（`AUTH_USER_MAPPING`）

| 値                        | principal                                                     |
| ------------------------- | ------------------------------------------------------------- |
| `email-localpart`（既定） | email の `@` より前（`alice@example.com` → `alice`）          |
| `email`                   | email 全体                                                    |
| `user`                    | `AUTH_SSO_HEADER_USER`（既定 `x-forwarded-user`）の値そのまま |

`email` 系を使うときは `AUTH_SSO_HEADER_EMAIL`（既定 `x-forwarded-email`）が、`user` を
使うときは `AUTH_SSO_HEADER_USER` が、それぞれ proxy から付与されている必要があります。

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

Hubble 自体の永続化（notebooks / saved queries / query history。クエリ対象データそのもの
ではない）は PostgreSQL（`DATABASE_URL`、**1st / production 推奨**）または SQLite
（`DB_PATH`、non-production 向け）のいずれかを選べます。**選択方法**: `DATABASE_URL` に
`postgres://` または `postgresql://` 形式の接続文字列を設定すると PostgreSQL になり、
`DB_PATH` より優先されます。`DATABASE_URL` が未設定（または空文字）のときは `DB_PATH` の
SQLite を使います。`postgres` / `postgresql` 以外のスキームは起動時エラーで停止します。
どちらを採用したかは起動ログに 1 行出力されます。

保存内容はどちらのバックエンドでも**要約のみ**です: `notebooks` / `saved_queries` /
`query_history`（と各セルの最終実行サマリ）。**結果の行データは保存しません**
（サーバーメモリ + TTL sweep）。スキーマは `packages/server/migrations` を両バックエンドで
共有し、起動時に自動適用されます（`schema_migrations` テーブルで適用管理）。

### 9.1 PostgreSQL バックエンド（主）

- **接続設定**: `DATABASE_URL=postgres://user:pass@host:5432/dbname` の形式で指定します。
  マネージド PostgreSQL（RDS / Cloud SQL 等）や既存クラスタの利用を想定しており、この
  リポジトリには PostgreSQL 本体のプロビジョニングは含まれません（docker-compose.yml は
  例外的にデモ用に同梱、[`deployment.md` §3](deployment.md#3-docker-composeデモ-trino-込み)）。
- **接続プール**: プロセスごとにプールサイズは妥当な既定（**最大 5 接続**）で固定しており、
  追加の環境変数はありません。複数プロセス（replicas>1）で運用する場合は、DB 側の
  `max_connections` を計画する際に Hubble のプロセス数 × 5 を上限の目安にしてください。
- **マイグレーション**: 起動時に自動適用されます。複数プロセスの同時起動に備え、
  マイグレーション適用を advisory lock（`pg_advisory_lock`）で直列化するため、`replicas`
  を 1 に固定しなくても安全に複数プロセスを起動できます。
- **バックアップ**: `pg_dump` / `pg_restore` を使ってください。

  ```bash
  pg_dump "$DATABASE_URL" -Fc -f /backup/hubble-$(date +%F).dump
  # リストアは pg_restore
  pg_restore -d "$DATABASE_URL" --clean /backup/hubble-YYYY-MM-DD.dump
  ```

- **監視観点**: 接続プールの枯渇（同時プロセス数 × 5 が DB 側の上限に近づいていないか）、
  advisory lock 待ちの長時間化（複数プロセスが同時に起動し続けていないか）、マイグレーション
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

### 9.3 SQLite から PostgreSQL への移行（概略）

SQLite → PostgreSQL の自動移行ツールは提供していません。保存内容は
`notebooks` / `saved_queries` / `query_history` の 3 テーブルのみのため、手動移行は
次の手順が目安です。

1. Hubble を停止し、SQLite ファイルのオンラインバックアップを取る（§9.2）。
2. `sqlite3 hubble.db .dump` 等で対象 3 テーブルのデータをエクスポートする。
3. 移行先 PostgreSQL に対して `packages/server/migrations` のマイグレーションを適用済みの
   状態にする（`DATABASE_URL` を設定して一度 Hubble を起動すればスキーマが作られる）。
4. エクスポートしたデータを PostgreSQL の型に合わせて INSERT する（日時型や真偽値の
   表現差に注意）。
5. `DATABASE_URL` を設定して Hubble を再起動し、Notebook / 保存クエリ / 履歴が想定どおり
   見えるか確認する。

### 9.4 none → proxy 切替時の owner backfill

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

| 変数                   | 意味                                   | 目安                                                                           |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `QUERY_MAX_ROWS`       | 1 クエリでメモリにバッファする行数上限 | 大きいほどメモリ消費増。既定 100k。画面表示は上限まで、超過分は truncated 表示 |
| `QUERY_CONCURRENCY`    | 同時に追走するクエリ数                 | サーバーの CPU/メモリと Trino 同時実行枠から決定。既定 5                       |
| `QUERY_TTL_MINUTES`    | 完了クエリの保持時間                   | 長いほど再接続でスナップショットを取り戻しやすいがメモリ占有。既定 30 分       |
| `METADATA_TTL_SECONDS` | メタデータキャッシュ TTL               | 短いほど鮮度が上がるが Trino へのメタデータ問い合わせが増える。既定 300 秒     |
| `QUERY_OVERFLOW_MODE`  | 上限超過時                             | `truncate`（既定, 打ち切り）/ `cancel`（クエリ中止）                           |

大結果のダウンロードについて：画面のグリッドは `QUERY_MAX_ROWS` で打ち切られますが、
**CSV ダウンロードは別ストリームで実行**されます。バッファが truncated だった場合は
**ダウンロード用にクエリを再実行**しながら（`source=hubble-download`）全件を流すため、
画面の上限とは独立に全件取得できます。再実行コストがかかる点と、resource group の
`download` 枠（[§8.3](#83-resource-group-分離source-別)）に注意してください。

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
終わっていなければ次の発火はスキップされます。`SCHEDULER_MAX_CONCURRENT`（既定 2）は
スケジューラー全体での同時実行上限です。

スケジューラーは **replicas=1 前提**で動作します（スケーリング時に重複実行が発生するため）。
PostgreSQL バックエンドで API サーバー自体を複数レプリカに増やす場合でも、
スケジューラーの tick ループは 1 レプリカでのみ有効化してください
（`SCHEDULER_ENABLED=false` を他レプリカに設定するなど）。

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
を付与します。ロール解決は owner
文字列のみを使うため、`rbac.yaml` の `group` 割り当てはスケジュール実行に適用されません
（`email` / `user` 割り当てを使うか、owner をメール形式で保存してください。README の RBAC 節参照）。
**結果の行データは
保存されません**（完了ステータス・試行回数・rowCount・elapsedMs・trinoQueryId・エラーのみ
記録）。履歴はスケジュールごとに直近 `SCHEDULER_RUNS_RETENTION`（既定 50）件を保持し、
それを超えた古い行は自動でプルーンされます。

### スケジューラーの無効化

`SCHEDULER_ENABLED=false` でスケジューラーの tick ループを停止できます。この場合、
API（スケジュールの登録・閲覧・手動実行エンドポイント）は引き続き利用可能です。
手動実行（`POST /api/schedules/:id/run`）はこの設定に関わらず機能します。

---

## 13. 関連ドキュメント

- 利用者向け操作: [`user-guide.md`](user-guide.md)
- Docker / Compose / Kubernetes デプロイ: [`deployment.md`](deployment.md)

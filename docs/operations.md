# Hubble SQL Workbench 運用ガイド

このドキュメントは、社内で **Hubble SQL Workbench**（以下 Hubble）をホストする運用者
向けの導入・設定・運用マニュアルです。利用者向けの操作は [`user-guide.md`](user-guide.md)、
設計の背景は [`design.md`](design.md) を参照してください。

> 本書に載せた起動・確認コマンドは、Trino 稼働中の環境で実機検証しています
> （oauth2-proxy の実体は不要。`AUTH_MODE=proxy` のヘッダ注入は curl で検証）。

---

## 1. アーキテクチャ概要

Hubble は **Hono 製の BFF（server）+ React 製の web** からなる単一プロセスのアプリです。
`STATIC_DIR` に web のビルド成果物を指すと、server が静的ファイル配信も担うため、
プロセスは 1 つで完結します。永続化は SQLite、データソースは Trino のみです。

```
                認証ヘッダ付与            技術アカウント Basic auth
                (任意)                    + X-Trino-User: <principal>
  ┌─────────┐   ┌──────────────┐   ┌──────────────────────┐   ┌────────┐
  │ ブラウザ │──▶│ oauth2-proxy │──▶│  hubble server (Hono) │──▶│ Trino  │
  └─────────┘   │  (SSO 前段)   │   │  + 静的配信 (web/dist) │   └────────┘
                └──────────────┘   │  + SQLite 永続化       │
                  ※proxy モード時   └──────────┬───────────┘
                  のみ                          │
                                                ▼
                                        ┌──────────────┐
                                        │ SQLite (DB)  │  notebooks /
                                        │  hue_fable.db │  saved_queries /
                                        └──────────────┘  query_history
```

- **認証なし（`AUTH_MODE=none`、既定）**: oauth2-proxy を置かず、Trino には固定の
  `TRINO_USER` で接続します。ローカル・単一ユーザー・E2E 用。
- **SSO（`AUTH_MODE=proxy`）**: oauth2-proxy を前段に置き、付与された SSO ヘッダから
  principal を解決します。Trino へは技術アカウントの Basic auth で接続しつつ、
  `X-Trino-User: <principal>` で **impersonation** します。

`X-Trino-Source` を 3 値（`hubble` / `hubble-metadata` / `hubble-download`）で送るため、
Trino 側の resource group で「ユーザークエリ／メタデータ取得／ダウンロード再実行」を
分離できます（[§8.3](#83-resource-group-分離source-別)）。

---

## 2. 必要要件

| 項目 | 要件 |
|---|---|
| Node.js | **24 以上** |
| パッケージマネージャ | **pnpm 11**（`packageManager` は `pnpm@11.6.0`） |
| Trino | 到達可能なコーディネーター（Basic auth と impersonation の設定が前提） |
| OS | Linux 推奨（`better-sqlite3` のネイティブビルドが必要） |

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
`pnpm --filter @hue-fable/server start` は内部で `tsx src/index.ts` を実行します。

```bash
PORT=8081 \
DB_PATH=/var/lib/hubble/hue_fable.db \
STATIC_DIR=/opt/hubble/packages/web/dist \
TRINO_BASE_URL=http://trino.internal:8080 \
TRINO_USERNAME=hubble-svc TRINO_PASSWORD=*** \
TRINO_USER=hubble-svc \
  pnpm --filter @hue-fable/server start
```

起動ログに次が出れば配信込みで立ち上がっています。

```
hubble server listening on http://localhost:8081
serving static web app from /opt/hubble/packages/web/dist
```

`STATIC_DIR` が存在しないと警告を出して起動します（API のみ稼働）。

### 3.3 動作確認（curl）

```bash
# ヘルスチェック（認証不要）
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/api/healthz   # → 200

# SPA シェル（index.html, no-cache）
curl -s -D - -o /dev/null http://localhost:8081/ | grep -iE "HTTP/|cache-control|content-type"
#   HTTP/1.1 200 OK
#   cache-control: no-cache
#   content-type: text/html; charset=utf-8

# 公開設定（GET /api/config）
curl -s http://localhost:8081/api/config
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
ExecStart=/usr/bin/pnpm --filter @hue-fable/server start
Restart=on-failure
RestartSec=3

# 環境変数（または EnvironmentFile=/etc/hubble.env）
Environment=PORT=8081
Environment=DB_PATH=/var/lib/hubble/hue_fable.db
Environment=STATIC_DIR=/opt/hubble/packages/web/dist
Environment=TRINO_BASE_URL=http://trino.internal:8080
Environment=TRINO_USERNAME=hubble-svc
Environment=TRINO_USER=hubble-svc
# 機密は EnvironmentFile に分離するのが望ましい:
# EnvironmentFile=/etc/hubble.env   (TRINO_PASSWORD=... など)

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hubble
sudo systemctl status hubble
journalctl -u hubble -f
```

oauth2-proxy を前段に置く場合は、Hubble を `127.0.0.1:8081`（loopback）に bind し、
proxy をその upstream にするのが安全です（[§7](#7-認証-auth_modeproxy)）。

---

## 4. 環境変数リファレンス

正本は `packages/server/src/config.ts` です。未設定（または空文字）のとき既定値が使われます。

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `8081` | BFF の HTTP ポート |
| `DB_PATH` | `./data/hue_fable.db` | SQLite ファイルパス。`:memory:` で揮発（テスト用） |
| `STATIC_DIR` | （未設定 = 配信しない） | web ビルド成果物のディレクトリ。設定時に静的配信 + SPA フォールバック |
| `TRINO_BASE_URL` | `http://127.0.0.1:30080` | Trino コーディネーターのベース URL |
| `TRINO_USER` | `admin` | `X-Trino-User` の値（none モードの実行ユーザー兼所有者、proxy モードのメタデータ実行ユーザー） |
| `TRINO_USERNAME` | `admin` | Trino Basic auth のユーザー名（技術アカウント） |
| `TRINO_PASSWORD` | （空） | Trino Basic auth のパスワード（空文字を明示可） |
| `TRINO_SOURCE` | `hubble` | ユーザークエリの `X-Trino-Source` |
| `TRINO_METADATA_SOURCE` | `hubble-metadata` | メタデータ取得の `X-Trino-Source` |
| `DEFAULT_CATALOG` | （未設定） | 新規 Notebook の初期カタログ |
| `DEFAULT_SCHEMA` | （未設定） | 新規 Notebook の初期スキーマ |
| `DEFAULT_LIMIT` | `5000` | LIMIT 無しの `SELECT` に自動付加する行数 |
| `QUERY_MAX_ROWS` | `100000` | 1 クエリでサーバー側にバッファする行数上限 |
| `QUERY_CONCURRENCY` | `5` | 同時に追走（トラッキング）するクエリ数の上限 |
| `QUERY_TTL_MINUTES` | `30` | 完了クエリを保持してから sweep するまでの分数 |
| `QUERY_OVERFLOW_MODE` | `truncate` | `QUERY_MAX_ROWS` 超過時の挙動（`truncate` = 打ち切り / `cancel` = 中止） |
| `METADATA_TTL_SECONDS` | `300` | メタデータキャッシュの TTL（秒） |
| `APP_VERSION` | `0.1.0` | `GET /api/config` が返すバージョン |
| `AUTH_MODE` | `none` | 認証モード（`none` / `proxy`、[§7](#7-認証-auth_modeproxy)） |
| `AUTH_TRUSTED_PROXY_CIDRS` | `127.0.0.0/8,::1/128` | SSO ヘッダを信頼する送信元 CIDR（カンマ区切り） |
| `AUTH_SSO_HEADER_USER` | `x-forwarded-user` | SSO ユーザー名ヘッダ名（小文字比較） |
| `AUTH_SSO_HEADER_EMAIL` | `x-forwarded-email` | SSO メールヘッダ名（小文字比較） |
| `AUTH_USER_MAPPING` | `email-localpart` | principal の導出方法（`email-localpart` / `email` / `user`） |

不正な整数・列挙値（例 `AUTH_MODE=foo`）は起動時にエラーで停止します。

---

## 5. （参考）開発時の起動

開発時は server と web を別プロセスで立ち上げ、Vite が `/api` を server にプロキシします。

```bash
pnpm dev   # server(:8081) と web(:5173) を並列起動
# → http://localhost:5173
```

本番（単一プロセス）では [§3](#3-ビルドとデプロイ単一プロセス) を使ってください。

---

## 6. Trino 側の要件

### 6.1 技術アカウントと Basic auth

Hubble は固定の技術アカウント（`TRINO_USERNAME` / `TRINO_PASSWORD`）で Trino に Basic auth
接続します。`TRINO_BASE_URL` が HTTPS でないと Trino が Basic auth を拒否する構成もあるため、
本番では TLS 終端（直接 or リバースプロキシ）を用意してください。

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
  "catalogs": [
    { "user": ".*", "catalog": ".*", "allow": "read-only" }
  ]
}
```

`original_user` は Basic auth の認証ユーザー（= `TRINO_USERNAME`）、`new_user` は
`X-Trino-User` の principal です。実運用では `new_user` を社内ユーザーの命名規則に
合わせて絞ってください。

### 6.3 メタデータ実行ユーザーとカタログ可視性

メタデータ取得（カタログ／スキーマ／テーブル一覧、サンプル）は **technical principal
（`TRINO_USER`）** で実行され、キャッシュは全ユーザーで共有されます。**per-user の
カタログ可視性の差は v1.1 では非対応**です。ユーザーごとに見えるカタログ・スキーマを
変えたい場合は、現状では Hubble の technical user に対して Trino access control で
可視範囲を絞る運用になります。

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

| 値 | principal |
|---|---|
| `email-localpart`（既定） | email の `@` より前（`alice@example.com` → `alice`） |
| `email` | email 全体 |
| `user` | `AUTH_SSO_HEADER_USER`（既定 `x-forwarded-user`）の値そのまま |

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
upstreams    = ["http://127.0.0.1:8081/"]

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
  pnpm --filter @hue-fable/server start &

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
`X-Trino-Source` を 3 値で送ります**。

| `X-Trino-Source` | 用途 |
|---|---|
| `hubble` | ユーザーが実行する通常クエリ |
| `hubble-metadata` | カタログ／スキーマ／テーブル一覧・サンプル取得 |
| `hubble-download` | 結果 CSV ダウンロードの再実行 |

（既定値。`TRINO_SOURCE` / `TRINO_METADATA_SOURCE` で変更可。）そのため、queryText 依存の
脆い selector ではなく、**安定した `source` selector** で分離できます。

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
    { "source": "hubble",          "group": "global.interactive" },
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

---

## 9. データ管理（SQLite）

### 9.1 場所と内容

- ファイルは `DB_PATH`（既定 `./data/hue_fable.db`）。WAL モードのため、同じディレクトリに
  `-wal` / `-shm` の補助ファイルが生成されます。
- 保存内容は**要約のみ**: `notebooks` / `saved_queries` / `query_history`（と各セルの
  最終実行サマリ）。**結果の行データは保存しません**（サーバーメモリ + TTL sweep）。
- スキーマは `packages/server/migrations`（`0001_init.sql`, `0002_owner.sql`）で管理され、
  起動時に自動適用されます（`schema_migrations` テーブルで適用管理）。

### 9.2 バックアップ

稼働中はオンラインバックアップを使うのが安全です（WAL を正しく取り込めます）。

```bash
# オンライン（稼働中でも可）
sqlite3 /var/lib/hubble/hue_fable.db ".backup '/backup/hue_fable-$(date +%F).db'"

# あるいはサービス停止 → ファイルコピー（-wal/-shm も含めて or 停止で統合される）
sudo systemctl stop hubble
cp /var/lib/hubble/hue_fable.db /backup/
sudo systemctl start hubble
```

WAL を含む状態でファイルだけをコピーする際は、`-wal` / `-shm` も併せてコピーするか、
`sqlite3 … ".backup"` を使ってください。

### 9.3 none → proxy 切替時の owner backfill

`owner` カラムは migration `0002` で追加され、既存行は空文字で入ります。起動時に**空の
owner を `TRINO_USER` で埋めます**（`backfillOwners`、冪等）。

注意点：

- `none` モードで作った既存の Notebook・保存クエリ・履歴は、**すべて `TRINO_USER` の
  所有**になります。proxy へ切り替えても、それらは個々のエンドユーザーには見えません
  （`TRINO_USER` の principal だけが見える）。
- proxy 切替前に `TRINO_USER` を、移行後も意味のある値（例: 管理者アカウント）にしておくと
  扱いやすいです。
- 共有（他ユーザーへの公開）は v1.1 では非対応です。

---

## 10. チューニング

| 変数 | 意味 | 目安 |
|---|---|---|
| `QUERY_MAX_ROWS` | 1 クエリでメモリにバッファする行数上限 | 大きいほどメモリ消費増。既定 100k。画面表示は上限まで、超過分は truncated 表示 |
| `QUERY_CONCURRENCY` | 同時に追走するクエリ数 | サーバーの CPU/メモリと Trino 同時実行枠から決定。既定 5 |
| `QUERY_TTL_MINUTES` | 完了クエリの保持時間 | 長いほど再接続でスナップショットを取り戻しやすいがメモリ占有。既定 30 分 |
| `METADATA_TTL_SECONDS` | メタデータキャッシュ TTL | 短いほど鮮度が上がるが Trino へのメタデータ問い合わせが増える。既定 300 秒 |
| `QUERY_OVERFLOW_MODE` | 上限超過時 | `truncate`（既定, 打ち切り）/ `cancel`（クエリ中止） |

大結果のダウンロードについて：画面のグリッドは `QUERY_MAX_ROWS` で打ち切られますが、
**CSV ダウンロードは別ストリームで実行**されます。バッファが truncated だった場合は
**ダウンロード用にクエリを再実行**しながら（`source=hubble-download`）全件を流すため、
画面の上限とは独立に全件取得できます。再実行コストがかかる点と、resource group の
`download` 枠（[§8.3](#83-resource-group-分離source-別)）に注意してください。

---

## 11. トラブルシューティング

| 症状 | 主な原因と対処 |
|---|---|
| **Trino 接続失敗 / 5xx** | `TRINO_BASE_URL` の到達性、Basic auth（`TRINO_USERNAME`/`TRINO_PASSWORD`）、HTTPS 要否を確認。`curl -u user:pass <base>/v1/info` で疎通確認 |
| **401 UNAUTHENTICATED**（proxy） | SSO ヘッダが付いているか、送信元が `AUTH_TRUSTED_PROXY_CIDRS` 内か、`AUTH_USER_MAPPING` と実際のヘッダ（user/email）が整合しているかを確認 |
| **impersonation 拒否** | Trino のエラーに `Cannot impersonate` 等が出る。`etc/rules.json` の `impersonation` ルールで `original_user`（= `TRINO_USERNAME`）→ `new_user`（principal）が許可されているか確認 |
| **ポート競合** | `EADDRINUSE`。`PORT` を変更、または `ss -ltnp \| grep :8081` で占有プロセスを確認 |
| **DB ロック / busy** | 複数の server プロセスが同じ `DB_PATH` を開いていないか確認（単一プロセス前提）。WAL の `-wal`/`-shm` 残骸はプロセス停止後に統合される |
| **静的配信されない** | 起動ログに `serving static web app from …` が出ているか、`STATIC_DIR` が `index.html` を含むディレクトリ（= `web build` 済み）を指しているかを確認 |
| **メタデータが古い / 詰まる** | Data パネルの更新ボタンか `POST /api/metadata/refresh`。詰まりは [§8](#8-trino-resource-group-分離メタデータ取得詰まり対策) の resource group 分離で緩和 |

ログは systemd 運用なら `journalctl -u hubble -f` で確認できます。

---

## 12. 関連ドキュメント

- 利用者向け操作: [`user-guide.md`](user-guide.md)
- 設計・API 契約・データモデル: [`design.md`](design.md)
- v1 受け入れチェックリスト: [`acceptance-v1.md`](acceptance-v1.md)

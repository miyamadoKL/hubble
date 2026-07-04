# Hubble SQL Workbench デプロイガイド

このドキュメントは、**Hubble SQL Workbench**（以下 Hubble）を Docker / Docker Compose /
Kubernetes へデプロイする運用者向けの手順書です。単一プロセス構成、環境変数、SQLite の
永続化といった前提は [`operations.md`](operations.md) を参照してください。環境変数の正本は
`packages/server/src/config.ts`、一覧は
[`operations.md` §4](operations.md#4-環境変数リファレンス) です。

> Hubble は **server（Hono BFF）+ web（React）** の単一プロセスアプリです。`STATIC_DIR` に
> web のビルド成果物を指すと server が静的配信も担うため、コンテナは 1 つで完結します。
> 永続化は PostgreSQL（`DATABASE_URL`、1st/production 推奨）または SQLite（`DB_PATH`、
> non-production）、データソースは Trino / MySQL / PostgreSQL のマルチデータソースに
> 対応します（接続情報は `datasources.yaml`、[`operations.md` §1](operations.md#1-アーキテクチャ概要)）。

---

## 1. 構成ファイルの所在

| ファイル / ディレクトリ            | 役割                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| `Dockerfile`                       | multi-stage の本番イメージ（Node 24 + pnpm、web ビルド + tsx 実行） |
| `.dockerignore`                    | ビルドコンテキストの除外設定                                        |
| `docker-compose.yml`               | Hubble + デモ Trino（tpch）の一括起動                               |
| `deploy/docker/trino/etc/catalog/` | compose 用 Trino のデモカタログ（tpch）                             |
| `deploy/k8s/`                      | kustomize ベースの Kubernetes サンプルマニフェスト                  |
| `.env.example`                     | 環境変数テンプレート（`.env` は git 管理外）                        |

---

## 2. Docker 単体

### 2.1 ビルド

```bash
docker build -t hubble:0.1.0 .
```

multi-stage の流れ：

1. **deps** — `pnpm install --frozen-lockfile` で全 workspace を解決。
2. **builder** — `pnpm --filter web build` で `packages/web/dist` を生成。
3. **prod-deps** — `pnpm install --prod --filter "@hubble/server..."` で server と
   contracts の本番依存のみに pruning（`better-sqlite3` のネイティブ addon を含む）。
4. **runtime** — server / contracts の **TS ソース**（tsx で直接実行）、web の dist、
   本番 `node_modules` を配置。非 root（`node`）で実行。

イメージには次が既定で入っています（`docker run -e ...` で上書き可能）。

| 変数         | 既定（イメージ）         |
| ------------ | ------------------------ |
| `STATIC_DIR` | `/app/packages/web/dist` |
| `DB_PATH`    | `/data/hubble.db`        |
| `PORT`       | `8080`                   |

イメージは `DATABASE_URL` を既定で設定しないため、単体 `docker run` では
`DB_PATH`（SQLite、non-production 想定）が使われます。`/data` は `VOLUME` 化されており、
SQLite（`notebooks` / `saved_queries` / `query_history`）がコンテナ再作成をまたいで
永続化されます。**production では `-e DATABASE_URL=postgres://...` を渡して PostgreSQL に
してください**（[`operations.md` §9](operations.md#9-データ管理)）。

`datasources.yaml` は必須です。単体 `docker run` ではファイルをコンテナへマウントし、
`DATASOURCES_PATH` で参照します。

### 2.2 起動

```bash
docker run --rm \
  -p 8080:8080 \
  -v "$(pwd)/datasources.yaml:/etc/hubble/datasources.yaml:ro" \
  -e DATASOURCES_PATH=/etc/hubble/datasources.yaml \
  -e DATABASE_URL=postgres://hubble:***@postgres.internal:5432/hubble \
  -e TRINO_USER=hubble-svc \
  hubble:0.1.0
```

`TRINO_USER` は全 Trino データソース共通の impersonation ユーザーで、Trino 接続先
（`baseUrl`/`username`/`passwordEnv`|`passwordFile`/`source` 系）は `datasources.yaml`
側に書きます（README のデータソース設定を参照）。

### 2.3 動作確認

```bash
# ヘルスチェック（認証不要）
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/healthz   # → 200

# 公開設定
curl -s http://localhost:8080/api/config

# カタログ一覧（Trino 疎通確認）
curl -s http://localhost:8080/api/catalogs
```

ブラウザで <http://localhost:8080> を開くと SPA が配信されます（静的配信の挙動は
[`operations.md` §3.3](operations.md#33-動作確認curl)）。

---

## 3. Docker Compose（デモ Trino 込み）

外部 Trino が無くても、デモ用の Trino（tpch カタログ）込みで一括起動できます。

> **注意:** `env_file` の `required: false` 構文は Docker Compose v2.24 以降が必要です。

```bash
docker compose up --build
```

- `hubble` サービス: `Dockerfile` をビルドし `:8080` を公開。永続化は既定で PostgreSQL
  （`postgres` サービス、`DATABASE_URL`）。
- `trino` サービス — `trinodb/trino` 公式イメージ。`deploy/docker/trino/etc/catalog/tpch.properties`
  で tpch カタログのみ追加（他は公式デフォルト）。公式イメージ組込みの healthcheck により、
  `hubble` は `depends_on: service_healthy` で待機。
- `postgres` サービス: Hubble 自身の永続化（notebooks / saved queries / query history）用
  PostgreSQL。名前付きボリューム `hubble-postgres-data` に永続化。クエリ対象データの
  postgresql データソースとは別物。

Hubble → Trino の接続情報は `deploy/compose/datasources.yaml`（`DATASOURCES_PATH` でマウント）
に定義されており、既定はサービス名接続（`baseUrl: http://trino:8080`）です。外部 Trino を
使う場合はそのファイルの `baseUrl` / `username` / `passwordEnv` を書き換えるか、
`DATASOURCES_PATH` で別ファイルを指してください。ローカルの `.env`（git 管理外）があれば
`env_file` で読み込まれ、`TRINO_PASSWORD` や `DATABASE_URL` など任意の変数を上書きできます。

確認：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/healthz   # → 200
curl -s http://localhost:8080/api/catalogs                                   # tpch を含む
```

停止と片付け：

```bash
docker compose down           # コンテナ停止（ボリュームは保持）
docker compose down -v        # ボリューム（SQLite データ）も削除
```

---

## 4. Kubernetes（kustomize）

`deploy/k8s/` に kustomize ベースのサンプルがあります。構成リソース：

| リソース          | 役割                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `namespace.yaml`  | namespace `hubble`                                                                                                                  |
| `configmap.yaml`  | 非機密の環境変数 + `datasources.yaml` 本体（ConfigMap のキーとしてマウント）                                                        |
| `secret.yaml`     | `TRINO_PASSWORD`（`datasources.yaml` の `passwordEnv` 参照先）と `DATABASE_URL`（**いずれもプレースホルダ**。実値に差し替えること） |
| `pvc.yaml`        | SQLite 用 PVC（`ReadWriteOnce`、`/data` にマウント）。**non-production 向け、既定の `kustomization.yaml` には含まれない**           |
| `deployment.yaml` | Deployment（既定 **replicas=1**、`RollingUpdate`、`/api/healthz` で liveness/readiness）                                            |
| `service.yaml`    | Service（`ClusterIP`、`:80` → コンテナ `:8080`）                                                                                    |

既定は PostgreSQL（`DATABASE_URL`、`secret.yaml`）が永続化バックエンドです。DB を外部の
PostgreSQL が一元管理するため `replicas` を 1 に固定する必要はなく、`RollingUpdate` で
複数レプリカに増やせます（増やす場合は `deployment.yaml` の `replicas` を変更）。
`DATABASE_URL` の例：

```yaml
# deploy/k8s/secret.yaml
stringData:
  DATABASE_URL: postgres://hubble:CHANGE_ME@postgres.hubble.svc:5432/hubble
```

non-production で SQLite（`DB_PATH` + PVC）を使う場合は `pvc.yaml` を
`kustomization.yaml` の `resources` に追加し、`deployment.yaml` の PVC マウント（コメント
アウト済み）を有効化してください（[§5](#5-永続化バックエンドと-replicas-の制約)）。この
場合のみ `replicas=1` / `Recreate` が必須です。

### 4.1 レンダリングと検証

```bash
# マニフェストのレンダリング
kubectl kustomize deploy/k8s

# クラスタに永続化せずに検証（サーバーサイド dry-run）
kubectl apply -k deploy/k8s --dry-run=server
```

> サーバーサイド dry-run は namespace を実際には作成しないため、`namespace` と
> namespaced リソースを同時に渡すと「namespaces "hubble" not found」が出ることがあります。
> その場合は先に namespace だけ作成（`kubectl create namespace hubble`）してから
> namespaced リソースを dry-run するか、本適用してください。

### 4.2 イメージの差し替え

`deployment.yaml` の `image: hubble:0.1.0` はプレースホルダです。自分のレジストリ／タグへは
`kustomization.yaml` の `images:` ブロックで差し替えます。

```yaml
# deploy/k8s/kustomization.yaml
images:
  - name: hubble
    newName: registry.example.com/hubble
    newTag: '0.1.0'
```

または CLI で：

```bash
# standalone の kustomize CLI がある場合
cd deploy/k8s
kustomize edit set image hubble=registry.example.com/hubble:0.1.0
```

### 4.3 適用

```bash
kubectl apply -k deploy/k8s
kubectl -n hubble rollout status deploy/hubble
kubectl -n hubble port-forward svc/hubble 8080:80   # ローカルから確認する場合
```

`TRINO_PASSWORD` / `DATABASE_URL` は `secret.yaml` のプレースホルダを実値に差し替えるか、
外部のシークレット管理（sealed-secrets / external-secrets 等）で注入してください。
SSO を前段に置く場合（`AUTH_MODE=proxy`）は [`operations.md` §7](operations.md#7-認証-auth_modeproxy)
を参照し、oauth2-proxy などを Service の前段に配置します。

### 4.4 docker が無いノードへイメージを配る

ビルドマシンと実行ノードが別で、実行ノードに docker が無い（k3s の containerd だけ）場合は、
別マシンで build したイメージを save → 実行ノードへ転送 → containerd に import します。

```bash
# ビルドマシン（docker あり）
docker build -t hubble:0.1.0 .
docker save hubble:0.1.0 -o hubble-0.1.0.tar

# 実行ノードへ転送後（k3s の containerd へ取り込み）
sudo k3s ctr images import hubble-0.1.0.tar
```

取り込んだイメージはローカルにあるため、Deployment の `imagePullPolicy` は `IfNotPresent`
（既定でローカル優先）で動きます。プライベートレジストリが使えるなら、push/pull の方が
運用は簡単です。

---

## 5. 永続化バックエンドと replicas の制約

Hubble の永続化は PostgreSQL（`DATABASE_URL`、1st/production 推奨）または SQLite
（`DB_PATH`、non-production）です。どちらも要約データ（notebooks / saved_queries /
query_history）のみを保持し、結果の行データは保存しません
（[`operations.md` §9](operations.md#9-データ管理)）。

### PostgreSQL（既定、production 推奨）

DB を外部の PostgreSQL が一元管理するため、**`replicas` を 1 に固定する必要はありません**。
`deployment.yaml` は既定で `replicas: 1` + `RollingUpdate` ですが、負荷に応じて `replicas`
を増やしても DB 競合は起きません。PVC も不要です。バックアップは `pg_dump` / `pg_restore`
を使ってください（[`operations.md` §9.1](operations.md#91-postgresql-バックエンド主)）。

### SQLite（non-production 向け）

SQLite は**単一ファイル**（`DB_PATH`）を使うため、複数プロセスから同時に開けません。
SQLite を使う場合のみ、次が**必須**です。

- Kubernetes では **replicas を 1 に固定**し、PVC は `ReadWriteOnce`、ロールアウト戦略は
  `Recreate`（旧 Pod が PVC を解放してから新 Pod が attach）にする（`pvc.yaml` を
  `kustomization.yaml` に追加し、`deployment.yaml` のコメントアウト済み設定を有効化）。
  `RollingUpdate` や replicas>1 は DB 競合や破損の原因です。
- Hubble は水平スケールしません。負荷はデータソース（Trino 等）側でスケールさせます。
- バックアップは稼働中ならオンラインバックアップ（`sqlite3 … ".backup"`）が安全です
  （[`operations.md` §9.2](operations.md#92-sqlitenon-production-向け)）。

---

## 6. 関連ドキュメント

- 運用全般・環境変数・認証・チューニング: [`operations.md`](operations.md)
- 利用者向け操作: [`user-guide.md`](user-guide.md)

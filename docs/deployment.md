# Hubble SQL Workbench デプロイガイド

このドキュメントは、**Hubble SQL Workbench**（以下 Hubble）を Docker / Docker Compose /
Kubernetes へデプロイする運用者向けの手順書です。単一プロセス構成、環境変数、SQLite の
永続化といった前提は [`operations.md`](operations.md) を参照してください。環境変数の正本は
`packages/server/src/config.ts`、一覧は
[`operations.md` §4](operations.md#4-環境変数リファレンス) です。

> Hubble は **server（Hono BFF）+ web（React）** の単一プロセスアプリです。`STATIC_DIR` に
> web のビルド成果物を指すと server が静的配信も担うため、コンテナは 1 つで完結します。
> 永続化は SQLite（`DB_PATH`）、データソースは Trino のみです。

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

`/data` は `VOLUME` 化されており、SQLite（`notebooks` / `saved_queries` / `query_history`）が
コンテナ再作成をまたいで永続化されます。

### 2.2 起動

```bash
docker run --rm \
  -p 8080:8080 \
  -v hubble-data:/data \
  -e TRINO_BASE_URL=http://trino.internal:8080 \
  -e TRINO_USER=hubble-svc \
  -e TRINO_USERNAME=hubble-svc \
  -e TRINO_PASSWORD=*** \
  hubble:0.1.0
```

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

- `hubble` サービス — `Dockerfile` をビルドし `:8080` を公開。SQLite は名前付きボリューム
  `hubble-data`（`/data`）に永続化。
- `trino` サービス — `trinodb/trino` 公式イメージ。`deploy/docker/trino/etc/catalog/tpch.properties`
  で tpch カタログのみ追加（他は公式デフォルト）。公式イメージ組込みの healthcheck により、
  `hubble` は `depends_on: service_healthy` で待機。

Hubble → Trino はサービス名で接続します（既定 `TRINO_BASE_URL=http://trino:8080`）。
ローカルの `.env`（git 管理外）があれば `env_file` で読み込まれ、任意の変数を上書きできます
（外部 Trino を使う場合は `.env` に `TRINO_BASE_URL=...` を置く）。

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

| リソース          | 役割                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `namespace.yaml`  | namespace `hubble`                                                 |
| `configmap.yaml`  | 非機密の環境変数（`TRINO_BASE_URL` 等）                            |
| `secret.yaml`     | `TRINO_PASSWORD`（**プレースホルダ**。実値に差し替えること）       |
| `pvc.yaml`        | SQLite 用 PVC（`ReadWriteOnce`、`/data` にマウント）               |
| `deployment.yaml` | Deployment（**replicas=1**、`/api/healthz` で liveness/readiness） |
| `service.yaml`    | Service（`ClusterIP`、`:80` → コンテナ `:8080`）                   |

> 上記サンプルは SQLite 前提です。永続化に外部 PostgreSQL を使う場合は `pvc.yaml` が
> 不要になり、`replicas=1` の制約も外せます（[§5](#5-sqlite-の永続化と-replicas1-の制約)）。
> `DATABASE_URL` は接続情報を含むため、`secret.yaml` 経由で渡してください（例）。
>
> ```yaml
> # deploy/k8s/secret.yaml（例）。実値に差し替えること。
> # stringData:
> #   DATABASE_URL: postgres://hubble:CHANGE_ME@postgres.hubble.svc:5432/hubble
> ```

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

`TRINO_PASSWORD` は `secret.yaml` のプレースホルダを実値に差し替えるか、外部の
シークレット管理（sealed-secrets / external-secrets 等）で注入してください。
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

## 5. SQLite の永続化と replicas=1 の制約

Hubble の永続化は**単一の SQLite ファイル**（`DB_PATH`）です。これは要約データ
（notebooks / saved_queries / query_history）のみを保持し、結果の行データは保存しません
（[`operations.md` §9](operations.md#9-データ管理sqlite)）。

- **同じ DB を複数プロセスで開かないこと**。Kubernetes では **replicas を 1 に固定**し、
  PVC は `ReadWriteOnce`、ロールアウト戦略は `Recreate`（旧 Pod が PVC を解放してから
  新 Pod が attach）にしています。`RollingUpdate` や replicas>1 は DB 競合・破損の原因です。
- Hubble は水平スケールしません。負荷はデータソース（Trino）側でスケールさせます。
- バックアップは稼働中ならオンラインバックアップ（`sqlite3 … ".backup"`）が安全です
  （[`operations.md` §9.2](operations.md#92-バックアップ)）。

> **PostgreSQL を使う場合**: 永続化バックエンドを PostgreSQL（`DATABASE_URL`）にすると
> 上記の `PVC` は不要になり、ロールアウト戦略や `replicas=1` の制約も外せます（DB を
> 外部の PostgreSQL が一元管理するため）。`replicas=1` / `ReadWriteOnce` の PVC が必要なのは
> SQLite を使う場合のみです。詳細は [`operations.md` §9.4](operations.md#94-postgresql-バックエンド)。

---

## 6. 関連ドキュメント

- 運用全般・環境変数・認証・チューニング: [`operations.md`](operations.md)
- 利用者向け操作: [`user-guide.md`](user-guide.md)

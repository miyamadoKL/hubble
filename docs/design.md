# hubble 設計ドキュメント

> Status: FINAL (v1) — 2026-06-12 確定。

## 1. ゴール

cloudera/hue の Notebook 機能を担保しつつ、モダンに作り変えた **Trino 専用クエリエディター**。

- Hue の Notebook 体験 (複数セル、セルごとの実行と結果、変数置換、履歴、保存、スキーマブラウザ、チャート) を Trino 専用に再構築する
- 名称・ロゴなど商標要素は再現しない (アプリ表示名: **Hubble SQL Workbench**)

## 2. 非ゴール (v1)

- ~~マルチユーザー認証 (oauth2-proxy / Google OAuth2)。ローカル/シングルユーザー前提、`X-Trino-User` は設定値~~ → **v1.1 で実装済み (§11)。`AUTH_MODE=none` (既定) が従来のシングルユーザー動作**
- Trino 以外のエンジン対応、Hue の Document 共有/権限/Gist/スケジュール (Oozie)/HDFS エクスポート
- 地図チャート (map/gradientmap)、Jupyter 相互変換 (Hue 本体にも無い)
- Helm / 本番配布

## 3. アーキテクチャ

pnpm workspace モノレポ。TypeScript で統一 (前回の Go backend は品質が高かったが、単一言語の方が世代交代・再生成が容易)。

```
hubble/
  pnpm-workspace.yaml
  docs/design.md
  packages/
    contracts/   # ★コントラクト層: zod スキーマ + 型。server/web 双方が依存。手で慎重に変更
    server/      # Hono BFF: Trino REST プロキシ + SQLite 永続化。再生成可能な実装層
    web/         # React 19 + Vite + Tailwind v4。再生成可能な実装層
  e2e/           # Playwright (視覚検証は必須ゲート)
```

### 採用スタック

| 層 | 技術 | 理由 |
|---|---|---|
| 契約 | zod + TypeScript | API/型を厳密定義、実装層は再生成可能に保つ |
| server | Hono + @hono/node-server | 薄い BFF。Trino `/v1/statement` プロキシ、SSE、CSV ストリーム |
| 永続化 | SQLite (better-sqlite3) + 自前 `schema_migrations` | ローカル前提。migration 管理を初日から入れる (前回教訓) |
| web | React 19 + Vite + Tailwind CSS v4 | デザイントークンを CSS variables で契約化 |
| エディター | Monaco + antlr4ng + antlr4-c3 | Trino の SQL 文法 (Apache-2.0) に基づく |
| 状態 | zustand (UI/notebook) + TanStack Query (サーバー状態) | 「60 useState + 70 引数ファサード」の再発防止 |
| グリッド | TanStack Virtual | 大結果の仮想スクロール (MUI DataGrid は使わない) |
| チャート | ECharts | bars/lines/timeline/pie/scatter を担保 |
| フォーマッタ | sql-formatter (trino dialect) | クライアント側整形。サーバー往復不要 |
| E2E | Playwright | tpch カタログ (ローカル Trino 30080) で決定的に検証 |

### Trino 実行フロー (server 内)

次のパターンで実装:

1. `POST /api/queries` → server が Trino `POST /v1/statement` を発行し即座に `{queryId}` を返す (202)
2. server がバックグラウンドで `nextUri` を追走 (バックオフ 20ms→max 1000ms)、行をメモリページストアに蓄積 (既定上限 100k 行 / 超過時は打ち切らずクエリ続行可否を設定で制御)
3. クライアントは `GET /api/queries/:id/events` (SSE) で `{state, stats, columns, rowsAppended}` を受信。再接続時は `GET /api/queries/:id` (snapshot) + `GET /api/queries/:id/rows?offset&limit`
4. `DELETE /api/queries/:id` → 追走中の `nextUri` へ DELETE 伝播
5. `GET /api/queries/:id/download.csv` → ページストアから chunked ストリーム (gzip 任意)。実行中なら追走しながら流す
6. 同時実行は semaphore (既定 5)。完了クエリは TTL (既定 30 分) で sweep

ヘッダ規約: `X-Trino-User` (設定値)、`X-Trino-Source: hubble` (ユーザークエリ) / `hubble-metadata` (メタデータ取得)。resource group をソース別に分けられるようにする (docs/hue-trino-metadata-contention 知見)。Basic auth は設定 (`TRINO_USERNAME`/`TRINO_PASSWORD`、既定 admin/空)。レスポンスヘッダ `x-trino-set-catalog/schema/session` をセッション状態へ反映。

### メタデータ

- `system.metadata.catalogs` / `information_schema.tables` / `information_schema.columns` を server がラップし TTL キャッシュ (既定 5 分) + stale-while-revalidate
- カタログツリーと補完エンジンは同じ API を共有。`POST /api/metadata/refresh` で手動更新

## 4. データモデル (Hue 互換概念 → 簡素化)

Hue の `Notebook { snippets[] }` を踏襲しつつ、前回教訓 (tabs/cells 二重保持禁止) を反映し **cells 一本化**:

```ts
Notebook { id, name, description, cells: Cell[], variables: Variable[], context: {catalog?, schema?}, createdAt, updatedAt }
Cell { id, kind: 'sql' | 'markdown', source, name?, collapsed?, resultMeta? /* 最終実行の要約のみ永続化 */ }
Variable { name, value, meta: { type: 'text'|'number'|'date'|'datetime-local'|'checkbox'|'select', options?: {label,value}[], placeholder? } }
QueryHistoryEntry { id, statement(先頭2000字), catalog, schema, trinoQueryId, state, rowCount, elapsedMs, errorMessage?, notebookId?, cellId?, submittedAt }
SavedQuery { id, name, description, statement, catalog?, schema?, isFavorite, createdAt, updatedAt }
```

- 実行中の結果データ (rows) は server メモリ + SSE。SQLite には**結果の要約のみ**保存 (前回の query_result_pages テーブル肥大を回避)
- 変数置換: `${name}` / `${name=default}` / `${name=opt1,opt2}` / `${name=label(value),...}`。SQL コメント内は除外。実行直前に解決 (Hue 仕様互換)
- Notebook は自動保存 (debounce 2s、draft フラグ) + 明示保存

## 5. 担保する Hue Notebook 機能 (v1 受け入れチェックリスト)

### セルと実行
- [ ] SQL セル / Markdown セル (live プレビュー)、追加 (末尾/上/下)・削除 (内容ありは確認)・ドラッグ並べ替え
- [ ] セル単位実行、**選択範囲のみ実行**、複数ステートメントの順次実行 (`;` 分割、エラーで停止)
- [ ] 全セル一括実行 (上から順次)
- [ ] キャンセル、進捗 (%/state/splits/rows/bytes/elapsed)、Trino Web UI へのリンク
- [ ] エラー表示: メッセージ + `line N:M` をエディターのマーカー/ガターに反映
- [ ] ガターにステートメント単位の状態アイコン (active/executing/done/failed) と実行ボタン
- [ ] LIMIT 自動付加 (SELECT に LIMIT 無し時、既定 5000、UI で変更/無効化可)
- [ ] EXPLAIN タブ (`EXPLAIN <stmt>` 実行)

### 変数
- [ ] `${var}` 構文 4 形式、型推論 (text/number/date/datetime-local/checkbox/select)、コメント内除外
- [ ] notebook 上部の変数パネル (Hue の variable substitution UI 相当)、変数入力中 Ctrl+Enter で実行

### 結果
- [ ] 仮想スクロールグリッド (固定ヘッダー、行番号列、追加ロード)
- [ ] 列の表示/非表示トグル、列名検索、列へスクロール、セル値検索 (クライアント側)
- [ ] チャート: bars / lines / timeline / pie / scatter。設定: X 軸、Y 軸 (複数)、ソート、件数制限
- [ ] CSV ダウンロード (ストリーム、gzip 任意)、クリップボードコピー (TSV + HTML)
- [ ] グリッド/チャート/EXPLAIN/エラー/実行詳細のタブ切替 (セルごとに状態保持)

### アシスト (左サイドバー)
- [ ] catalog → schema → table → column ツリー、遅延ロード、検索フィルタ
- [ ] テーブル/カラムのクリックでカーソル位置に挿入、ダブルクリックで SELECT 雛形
- [ ] テーブル詳細ポップオーバー (カラム一覧 + 型 + サンプルデータ 10 行)
- [ ] Notebook 一覧 / 保存クエリ一覧 / 履歴 (state 別表示、再オープン、ページング 50 件)

### エディター
- [ ] Monaco + Trino 文法ハイライト (ANTLR tokenizer) + テーブル名装飾 + ホバーでスキーマ表示
- [ ] 補完: キーワード + スニペット、テーブル名 (FQN + CTE)、カラム名 (カーソル文脈のテーブルから、一括カンマ列挙含む)
- [ ] 構文エラーのリアルタイムマーカー (200ms デバウンス)
- [ ] SQL フォーマット (選択範囲 or 全体)
- [ ] ショートカット: Ctrl/Cmd+Enter 実行、Ctrl/Cmd+S 保存、Ctrl/Cmd+I or Ctrl+Shift+F 整形、Ctrl/Cmd+K コマンドパレット、Ctrl+Alt+T テーマ切替

### 管理
- [ ] Notebook 保存 / Save As / 一覧 / 検索 / 削除、自動下書き保存と復元
- [ ] 保存クエリ CRUD + お気に入り
- [ ] 実行履歴の自動記録 (Hue の is_history 相当) と履歴からの再実行
- [ ] catalog.schema コンテキストセレクタ (上部バー、最近使った値を復元)

### Stretch (v1 必須ではない / 余力があれば)
- [ ] Presentation mode (`--` コメント見出しでカード分割表示)
- [ ] Trino 関数リファレンスパネル (右サイド)

## 6. 画面設計

Hue 利用者が迷わない構成、見た目はモダンに再設計:

```
┌──────────────────────────────────────────────────────────────┐
│ TopBar: ロゴ(文字) | Notebookタブ× n | catalog.schema | 実行▶ 保存 │
├──────────┬───────────────────────────────────────────────────┤
│ Sidebar  │ NotebookView (スクロール)                            │
│ ├ Data   │  ┌ Cell #1 [SQL] ───────────────────────────┐      │
│ ├ Notes  │  │ Monaco editor (auto-height)               │      │
│ ├ Saved  │  │ ── 進捗バー / stats ─────────────────────  │      │
│ ├ History│  │ [Grid|Chart|Explain|Details] 結果ペイン     │      │
│ └ (検索)  │  └──────────────────────────────────────────┘      │
│          │  [+ SQL] [+ Markdown]                              │
└──────────┴───────────────────────────────────────────────────┘
+ コマンドパレット (Ctrl+K) / トースト / 変数パネル (notebook 上部、変数検出時のみ)
```

### デザイン方針 (トークンは契約扱い)

- トーン: **refined data instrument** — 計器のような精密さ。装飾ではなく密度コントラストと正確なタイポグラフィで個性を出す
- タイポグラフィ: UI = **IBM Plex Sans** (+ JP)、コード/数値 = **IBM Plex Mono**。Inter/Arial/システムフォント禁止
- カラー: ライト基調「warm paper」(#faf9f7 系) + インクネイビーの文字 + **単一アクセント amber/copper 系**。ダークテーマ「midnight instrument」も同一トークン構造で提供。紫グラデーション禁止
- 密度: 4px グリッド。結果グリッド/ツリーは高密度 (行高 28px 級)、シェルは余白で呼吸
- モーション: 実行中の進捗とセル結果の出現 (150ms fade/slide) のみ。常時アニメーション禁止
- 全トークンは `packages/web/src/theme/tokens.css` の CSS variables に集約。**コンポーネント内の生 hex 禁止** (ast-grep ルールで lint)
- ロゴ/名称: テキストロゴ「Hubble」のみ。Hue/Cloudera/Trino の商標・ロゴは使用しない

## 7. API 契約 (v1)

`packages/contracts/src/` の zod 定義を正とする。エンドポイント一覧:

```
GET    /api/healthz
GET    /api/config                        # { trino: {url, user}, defaults: {catalog?, schema?, limit}, authMode, guard: {mode, maxScanBytes, maxScanRows, onUnknown, bytesPerSecond}, version }
GET    /api/catalogs                      # MetadataResponse<Catalog>
GET    /api/catalogs/:c/schemas
GET    /api/catalogs/:c/schemas/:s/tables
GET    /api/catalogs/:c/schemas/:s/tables/:t        # columns + 型 + comment
GET    /api/catalogs/:c/schemas/:s/tables/:t/sample # 10 行サンプル
POST   /api/metadata/refresh              # {catalog?, schema?}
POST   /api/queries                       # { statement, catalog?, schema?, sessionProperties?, source?, notebookId?, cellId?, maxRows? } → 202 {queryId}; enforce モード上限超過時は 422 { error: { code: "QUERY_BLOCKED" } }
POST   /api/queries/estimate              # Query Guard 推定: EstimateRequest → EstimateResult (packages/contracts/src/estimate.ts)
GET    /api/queries/:id                   # snapshot: state, stats, columns, rowCount, error?, trinoQueryId, infoUri
GET    /api/queries/:id/events            # SSE: state/stats/columns/rows-chunk/error/done
GET    /api/queries/:id/rows?offset&limit # ページ取得
DELETE /api/queries/:id
GET    /api/queries/:id/download.csv?compression=gzip
GET    /api/notebooks?query=              # 一覧+検索 / POST 作成
GET|PUT|DELETE /api/notebooks/:id
GET    /api/saved-queries?query= / POST / PUT|DELETE /api/saved-queries/:id
GET    /api/history?offset&limit&state=
```

`MetadataResponse<T> = { items: T[], source: 'cache'|'live', stale: boolean, lastUpdatedAt }` (前回契約踏襲)。
エラー形式は全 API 共通 `{ error: { code, message, trinoErrorName?, line?, column? } }`。

## 8. エディター資産 (Trino SQL grammar)

`packages/web/src/trino-lang/` に以下を含む (Apache-2.0、出典コメントと LICENSE/NOTICE を保持):

- `SqlBase.g4` + 生成済み `SqlBaseLexer.ts` / `SqlBaseParser.ts` (antlr4ng、再生成スクリプトも移植)
- `sql/`: SqlBaseListenerImpl, SqlBaseErrorListener, TokenMap, SpecialHighlight, StatementDescriptor, NamedQuery
- `schema/`: Catalog, Schema, Table, Column, TableReference

改修方針 (調査結論):
- `SchemaProvider` は **シングルトン廃止、メタデータ取得関数を DI** (`/api/catalogs...` クライアントを注入)。Trino 直結クライアントへの結合を断つ
- `QueryEditorPane` (950 行モノリス) は移植せず、機能を分解して再実装: tokenizer 登録 / completion provider / hover provider / marker 更新 / formatter をそれぞれ独立モジュール化し `registerTrinoLanguage(monaco, deps)` で一括登録
- 補完は **ファントムカーソル方式** (`__cursor__` 挿入→ antlr4-c3、preferredRules = qualifiedName/identifier/relationPrimary/expression) を採用し、スキーマ候補生成ロジック (テーブル名 + CTE 名 + カラム) を組み合わせる
- 競合状態対策: 補完/解析は AbortController + 世代カウンタで古い結果を破棄

## 9. 実装フェーズ

| Phase | 内容 | 依存 | 担当 |
|---|---|---|---|
| P1 | scaffold + contracts (zod) + デザイントークン + lint 基盤 (ast-grep 含む) | - | Opus |
| P2a | server 全実装 (Trino client/クエリ registry/SSE/CSV/metadata/SQLite CRUD) + vitest | P1 | Opus ∥ |
| P2b | web デザインシステム + アプリシェル (TopBar/Sidebar/タブ/パレット骨格、モックデータ) | P1 | Opus ∥ |
| P3a | trino-lang fork + Monaco 統合 (補完/ハイライト/ホバー/マーカー/フォーマット) | P2b | Opus ∥ |
| P3b | 実行フロー (SSE) + 結果グリッド + 進捗 + エラー + EXPLAIN + CSV/コピー | P2a,P2b | Opus ∥ |
| P4 | Notebook 機能 (セル CRUD/DnD/markdown/全実行/変数/保存/履歴/保存クエリ/コンテキスト) | P3a,P3b | Opus |
| P5 | チャート + ショートカット完備 + コマンドパレット + 仕上げ (+ stretch) | P4 | Opus |
| P6 | Playwright E2E (実 Trino tpch) + 視覚レビューゲート + 修正ループ | P5 | Opus + Fable レビュー |

各フェーズの完了条件: `pnpm typecheck && pnpm lint && pnpm test` 緑 + (UI フェーズは) スクリーンショットを Fable が視覚レビューして合格。

## 10. 前回の教訓 → 本設計での対策 (確定)

| 教訓 | 対策 |
|---|---|
| 8,347 行 App.tsx / 60 useState / 70 引数ファサード | zustand ストア分割 (notebook/execution/metadata/ui) + TanStack Query。コンポーネントは表示専務 |
| 手書きインラインスタイル集 (appShellStyle.ts 567 行) | Tailwind v4 + tokens.css。生 hex を ast-grep で禁止 |
| インフラ先行で UI に体力が回らず | v1 は認証/Helm/MySQL を切り、画面品質に全振り |
| tabs/cells 二重保持 | cells 一本化 |
| migration 無管理 (IF NOT EXISTS のみ) | schema_migrations テーブルで適用管理 |
| 視覚検証が最後 | P2b 以降、各フェーズでスクリーンショットゲート |
| 結果全行 DB 保存でテーブル肥大 | 結果はメモリ + TTL sweep、SQLite は要約のみ |

## 11. v1.1: 認証 — oauth2-proxy 前段 SSO (2026-06-12 追加)

§2 の「マルチユーザー認証は非ゴール」を v1.1 で解除する。方式は **oauth2-proxy 前段** (旧計画 `../docs/trino-hue-refactor-plan.md` §F の簡素化版)。アプリ自身は OAuth2 フローを持たず、信頼プロキシが付与するヘッダから認証コンテキストを解決する。

### 認証モード

`AUTH_MODE` 環境変数で切替:

- **`none` (既定)**: 従来動作。認証なし、principal は `TRINO_USER`。後方互換 (ローカル開発・E2E はこのモード)
- **`proxy`**: oauth2-proxy 配下で稼働。SSO ヘッダから principal を解決

### proxy モードの仕様

- **信頼境界**: `AUTH_TRUSTED_PROXY_CIDRS` (既定 `127.0.0.0/8,::1/128`)。socket リモートアドレスが信頼 CIDR 外のリクエストでは SSO ヘッダを**無視**する (ヘッダ偽装対策)
- **ヘッダ名** (小文字比較、設定可): `AUTH_SSO_HEADER_USER` 既定 `x-forwarded-user`、`AUTH_SSO_HEADER_EMAIL` 既定 `x-forwarded-email`
- **principal 解決** `AUTH_USER_MAPPING`: `email-localpart` (既定: email の `@` 前) | `email` (全体) | `user` (user ヘッダそのまま)。解決した principal を以後の所有者 ID 兼 Trino 実行ユーザーとする
- **解決不能** (ヘッダ欠落/信頼外) → `401 { error: { code: 'UNAUTHENTICATED', message } }`。静的アセットと `/api/healthz` は認証不要
- **Trino 実行**: 既存の固定技術アカウント Basic auth (`TRINO_USERNAME`/`TRINO_PASSWORD`) + `X-Trino-User: <principal>` (impersonation)。Trino 側で技術アカウントからの impersonation 許可が前提 (運用ドキュメントに記載)
- **メタデータ**: 取得は従来通り `TRINO_USER` (技術 principal) で実行し、キャッシュは全ユーザー共有。per-user のカタログ可視性差は v1.1 では非対応 (運用ドキュメントに注記)

### API / データモデル変更

- `GET /api/me` → `{ user, email?, authMode }` (contracts に MeResponse 追加)
- migration: `notebooks` / `saved_queries` / `query_history` に `owner` カラム追加。既存行は `TRINO_USER` 値で埋める。全 CRUD/一覧/検索/履歴記録を owner スコープに変更 (none モードの owner は `TRINO_USER`)
- 共有 (他ユーザーへの公開) は非対応。将来課題

### web 変更

- TopBar に現在ユーザー表示 (`/api/me`)。`authMode=none` では非表示
- API 401 (UNAUTHENTICATED) は全画面の「認証が必要です」状態を表示 (oauth2-proxy 配下では通常到達しない。直アクセス/セッション失効時のフォールバック)

### テスト

- server: 信頼 CIDR 内/外、ヘッダ解決 3 マッピング、401、owner スコープ (他人のデータが見えない/消せない)、X-Trino-User 伝播 (fake Trino)
- e2e: 既定スイートは none モードのまま。proxy モードは server ポートを分けたヘッダ注入テスト (oauth2-proxy 実体は不要) を 1 spec 追加

/**
 * 静的ファイル配信 + SPA フォールバック（`packages/server/src/http/staticRoutes.ts`）。
 *
 * ビルド済みの web アプリ（`packages/web` の Vite ビルド成果物）を BFF サーバー自身から配信する
 * ための処理をまとめる（design.md §3 のデプロイ/運用モデル）。`STATIC_DIR` 環境変数が設定された
 * ときのみ `app.ts` から呼び出され、API ルーター群より後にマウントすることで `/api/*` を
 * 横取りしないようにする。認証は適用されない（静的アセットは公開。design.md §11 参照）。
 *
 * 実装上の要点は、Hono の `@hono/node-server/serve-static` が `onFound` の時点ではまだ
 * `Response` を確定させておらず、その後に生成される `Response` へ後からヘッダーを差し込む
 * 必要がある点（`withCacheControl` 参照）。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AuthVariables } from '../auth/middleware';

/** Cache-Control for fingerprinted assets (Vite emits hashed file names). */
// Vite がファイル名にハッシュを埋め込むため、内容が変わればファイル名も変わる。
// よって安全に「恒久キャッシュ可能」として扱える。
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Cache-Control for the SPA entrypoint — always revalidate. */
// index.html はデプロイのたびに指すアセットが変わるため、常にサーバーへ再検証させる。
const NO_CACHE = 'no-cache';

/**
 * Decide the Cache-Control for a resolved file path. The SPA shell
 * (`index.html`) must never be cached so a deploy is picked up immediately;
 * hashed assets under the build output are immutable.
 *
 * 解決済みファイルパスから適切な Cache-Control ヘッダー値を決定する。
 * @param resolvedPath - `serveStatic` が解決した実ファイルパス（OS のパス区切り文字どちらでも可）。
 * @returns `index.html` なら `no-cache`、それ以外（ハッシュ付きアセット想定）なら `immutable`。
 */
export function cacheControlFor(resolvedPath: string): string {
  return /(?:^|[/\\])index\.html$/.test(resolvedPath) ? NO_CACHE : IMMUTABLE;
}

/**
 * `serveStatic`'s `root` is resolved relative to `process.cwd()`. Normalise an
 * absolute `STATIC_DIR` so an absolute deploy path (e.g. `/opt/hubble/web/dist`)
 * works regardless of where the process runs.
 *
 * `STATIC_DIR` 設定値を `serveStatic` の `root` オプションに渡せる形へ正規化する内部ヘルパー。
 * 絶対パスならそのまま `resolve` を通し、相対パスならそのまま返す（`serveStatic` 自身が
 * `process.cwd()` からの相対解決を行うため）。
 */
function toServeStaticRoot(staticDir: string): string {
  return isAbsolute(staticDir) ? resolve(staticDir) : staticDir;
}

// `serveStatic` builds the Response inside `c.body()` *before* it calls
// `onFound`, so headers set in `onFound` never land on the returned Response.
// We instead stash the resolved path on the context in `onFound`, then stamp
// the Cache-Control onto `c.res` after the inner handler finalizes.
// つまり `onFound` の時点で c.header() を呼んでも手遅れなので、代わりに解決済みパスだけを
// コンテキストに保存しておき、`withCacheControl` 側で完成した Response に後付けでヘッダーを刺す。
const RESOLVED_PATH = '__hubbleStaticPath';

/** `onFound` から解決済みパスをコンテキストへ書き込むための小さなヘルパー。 */
function rememberPath(path: string, c: Context): void {
  c.set(RESOLVED_PATH, path);
}

/**
 * Wrap a serveStatic handler so the served file gets the right Cache-Control.
 *
 * `serveStatic` ミドルウェアをラップし、返却された `Response` に対して事後的に
 * 適切な Cache-Control ヘッダーを設定するデコレータ関数。
 * @param inner - ラップ対象の `serveStatic` ミドルウェアハンドラ。
 * @param cacheFor - 解決済みパスから Cache-Control 値を決定する関数。
 * @returns ヘッダー付与ロジックを追加した新しいミドルウェアハンドラ。
 */
function withCacheControl(
  inner: MiddlewareHandler,
  cacheFor: (path: string) => string,
): MiddlewareHandler {
  return async (c, next) => {
    // serveStatic returns its Response when it serves a file; preserve it so
    // Hono treats the request as finalized.
    // inner 実行後に onFound 経由で保存されたパスを取り出し、ファイルが実際に見つかった
    // 場合（Response が返っている場合）のみヘッダーを追記する。
    const result = await inner(c, next);
    const path = c.get(RESOLVED_PATH) as string | undefined;
    if (result instanceof Response && path !== undefined) {
      result.headers.set('Cache-Control', cacheFor(path));
    }
    return result;
  };
}

/**
 * Register static file serving + SPA fallback for the built web app
 * (design.md §3 deployment / operations). When `staticDir` is set:
 *
 *  - `GET`/`HEAD` for a matching file under `staticDir` is served with an
 *    appropriate Cache-Control (immutable for hashed assets, no-cache for
 *    `index.html`).
 *  - any other non-`/api` path falls back to `index.html` so client-side
 *    routing works on hard refresh / deep links.
 *
 * `/api/*` is never touched here: this is mounted *after* the API routers and
 * the `/api/*` catch-all, so only non-API paths reach it. Auth is unaffected —
 * static assets are public, as required by §11.
 *
 * @param app - ミドルウェアを追加登録する対象の Hono アプリケーションインスタンス。
 *   `app.ts` から API ルーター登録後に呼び出される前提（呼び出し順序が `/api/*` 非干渉の鍵）。
 * @param staticDir - 配信するビルド成果物のルートディレクトリ（`STATIC_DIR` 環境変数由来）。
 */
export function registerStaticServing(
  app: Hono<{ Variables: AuthVariables }>,
  staticDir: string,
): void {
  const root = toServeStaticRoot(staticDir);
  const indexPath = join(root, 'index.html');

  // Real files first: serveStatic resolves the request path under `root`.
  // 実在するファイル（JS/CSS/画像など）へのリクエストは、まずここでそのまま返す。
  app.use('*', withCacheControl(serveStatic({ root, onFound: rememberPath }), cacheControlFor));

  // SPA fallback: any GET/HEAD that didn't match a file or an /api route gets
  // the app shell. `serveStatic` with a fixed `path` always serves index.html.
  // 上のミドルウェアでファイルが見つからなかった GET/HEAD は、常に index.html を返す
  // （React Router 等のクライアントサイドルーティングを深いリンクからでも動作させるため）。
  const serveIndex = withCacheControl(
    serveStatic({ path: indexPath, onFound: rememberPath }),
    () => NO_CACHE,
  );
  app.get('*', serveIndex);
  app.on('HEAD', '*', serveIndex);
}

/**
 * Warn (don't crash) if the configured static dir is missing at startup.
 *
 * 起動時に `STATIC_DIR` の存在を確認するためのヘルパー。存在しなくてもプロセスを
 * 落とさず、呼び出し元（起動処理）が警告ログを出す判断材料として使う。
 * @param staticDir - 確認対象のディレクトリパス。
 * @returns ディレクトリが存在すれば true。
 */
export function staticDirExists(staticDir: string): boolean {
  return existsSync(toServeStaticRoot(staticDir));
}

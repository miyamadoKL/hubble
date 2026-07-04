// Lazy, single-flight loader for the local Monaco bundle. The first caller
// triggers `import('monaco-editor')` (its own Vite chunk, so Monaco stays out
// of the initial payload). Subsequent callers get
// the cached namespace. Also installs the bundled editor web worker.
//
// ---- ファイル概要（日本語） ----
// ローカルバンドルされた Monaco を「遅延かつ一度だけ」ロードするためのモジュール。
// 最初の呼び出しで `import('monaco-editor/.../edcore.main')` を発火させ（Vite の
// 独立チャンクとして扱われるため、初期ロードのペイロードに Monaco を含めずに済む）、
// 2 回目以降の呼び出しはキャッシュされた
// Promise（＝同じ Monaco 名前空間）を返す（single-flight）。あわせて Monaco の
// エディター用 Web Worker のセットアップ（monacoSetup.ts）も初回ロード時に行う。

import type * as monaco from 'monaco-editor';
import { configureMonacoWorkers } from './monacoSetup';

// ロード中/ロード済みの Promise をキャッシュする変数。未初期化なら undefined。
let promise: Promise<typeof monaco> | undefined;

/**
 * Load (or return the cached) Monaco namespace. Workers are configured once.
 *
 * Monaco 名前空間をロードする（既にロード中/ロード済みならキャッシュされた
 * Promise をそのまま返す）。Web Worker のセットアップは初回のみ行う。
 */
export function loadMonaco(): Promise<typeof monaco> {
  if (!promise) {
    promise = (async () => {
      // エディター用 Web Worker のファクトリを一度だけ設定する。
      configureMonacoWorkers();
      // Import `edcore.main` — the editor *core* WITH all editor contributions
      // (suggest controller, hover, parameter hints, bracket matching, …) but
      // WITHOUT the language packs (css/html/json/ts) and their workers. The
      // umbrella `monaco-editor` would also pull ~8 MB of language workers we
      // never use for Trino SQL; the slim `editor.api` goes too far the other
      // way and omits the suggest/hover controllers, so completion silently does
      // nothing. edcore.main is the correct middle ground.
      //
      // 日本語: `edcore.main` は、補完(suggest)コントローラー、ホバー、パラメーター
      // ヒント、括弧マッチングなどエディターの各種コントリビューション「込み」だが、
      // 使わない言語パック（css/html/json/ts）とそれらの Worker は「含まない」
      // ビルドである。素の `monaco-editor` を import すると Trino SQL では使わない
      // 言語 Worker が ~8MB も付いてくる。逆に最小限の `editor.api` まで削ると
      // suggest/hover のコントローラー自体が欠け、補完が静かに何も起きなくなって
      // しまう。`edcore.main` はちょうどよい中間点である。
      // @ts-expect-error — subpath ships no .d.ts; types come from the cast.
      const mod = await import('monaco-editor/esm/vs/editor/edcore.main');
      // サブパスに型定義がないため、公式パッケージの型で明示的にキャストする。
      return mod as typeof import('monaco-editor');
    })();
  }
  return promise;
}

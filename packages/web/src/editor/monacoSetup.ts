// Local Monaco bundling (design.md §8: "monaco-editor は ローカルバンドル, CDN
// loader 禁止"). We configure MonacoEnvironment to instantiate the editor web
// worker from a Vite-bundled chunk (`?worker`), so no AMD loader / CDN fetch is
// involved. Trino SQL needs only the base editor worker (no JSON/TS/CSS langs).
//
// This module is imported once, lazily, from the SqlEditor's dynamic
// `import('monaco-editor')` chunk — keeping Monaco out of the initial bundle.
//
// ---- ファイル概要（日本語） ----
// Monaco を CDN から読み込むのではなく、ローカルバンドル（Vite の `?worker` 構文で
// バンドルされたチャンク）から Web Worker をインスタンス化するためのセットアップ
// モジュール（design.md §8: 「monaco-editor は ローカルバンドル, CDN loader 禁止」）。
// これにより AMD ローダーや外部 CDN への通信は一切発生しない。Trino SQL の言語
// サポートには基本のエディター Worker だけあれば十分で、JSON/TypeScript/CSS 用の
// 言語 Worker は不要なため読み込まない。
// このモジュール自体は SqlEditor 側の動的 `import('monaco-editor')` チェーンから
// 遅延かつ 1 回だけ import され、Monaco を初期バンドルの外に保つ設計の一部を担う。

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Worker のセットアップが既に行われたかどうかのフラグ（冪等性の担保）。
let configured = false;

/**
 * Install the worker factory once. Idempotent.
 *
 * Monaco の Web Worker ファクトリを一度だけインストールする。複数回呼んでも
 * 2 回目以降は何もしない（冪等）。
 */
export function configureMonacoWorkers(): void {
  if (configured) return;
  configured = true;
  // monaco-editor declares `MonacoEnvironment` globally; only `getWorker` is
  // needed (Trino SQL uses just the base editor worker — no JSON/TS/CSS langs).
  // monaco-editor はグローバルに `MonacoEnvironment` を参照する仕様になっており、
  // ここでは `getWorker` だけを実装すればよい（Trino SQL では基本の editor worker
  // のみを使い、JSON/TS/CSS 言語用の worker は使わないため）。
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}

// Local Monaco bundling (design.md §8: "monaco-editor は ローカルバンドル, CDN
// loader 禁止"). We configure MonacoEnvironment to instantiate the editor web
// worker from a Vite-bundled chunk (`?worker`), so no AMD loader / CDN fetch is
// involved. Trino SQL needs only the base editor worker (no JSON/TS/CSS langs).
//
// This module is imported once, lazily, from the SqlEditor's dynamic
// `import('monaco-editor')` chunk — keeping Monaco out of the initial bundle.

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

let configured = false;

/** Install the worker factory once. Idempotent. */
export function configureMonacoWorkers(): void {
  if (configured) return;
  configured = true;
  // monaco-editor declares `MonacoEnvironment` globally; only `getWorker` is
  // needed (Trino SQL uses just the base editor worker — no JSON/TS/CSS langs).
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}

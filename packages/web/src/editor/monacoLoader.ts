// Lazy, single-flight loader for the local Monaco bundle. The first caller
// triggers `import('monaco-editor')` (its own Vite chunk, so Monaco stays out
// of the initial payload — design.md §8 "チャンク分離"). Subsequent callers get
// the cached namespace. Also installs the bundled editor web worker.

import type * as monaco from 'monaco-editor';
import { configureMonacoWorkers } from './monacoSetup';

let promise: Promise<typeof monaco> | undefined;

/** Load (or return the cached) Monaco namespace. Workers are configured once. */
export function loadMonaco(): Promise<typeof monaco> {
  if (!promise) {
    promise = (async () => {
      configureMonacoWorkers();
      // Import `edcore.main` — the editor *core* WITH all editor contributions
      // (suggest controller, hover, parameter hints, bracket matching, …) but
      // WITHOUT the language packs (css/html/json/ts) and their workers. The
      // umbrella `monaco-editor` would also pull ~8 MB of language workers we
      // never use for Trino SQL; the slim `editor.api` goes too far the other
      // way and omits the suggest/hover controllers, so completion silently does
      // nothing. edcore.main is the correct middle ground.
      // @ts-expect-error — subpath ships no .d.ts; types come from the cast.
      const mod = await import('monaco-editor/esm/vs/editor/edcore.main');
      return mod as typeof import('monaco-editor');
    })();
  }
  return promise;
}

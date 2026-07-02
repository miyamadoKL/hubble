/**
 * localStorage のキー移行（マイグレーション）処理を定義するファイル。
 * このアプリはかつて `hue-fable` という名称だったため、当時保存された
 * `hue-fable-*` という接頭辞の localStorage キーが、旧バージョンを
 * 使っていたユーザーのブラウザに残っている可能性がある。
 * 本ファイルはそれらを新しい `hubble-*` キーへ一度だけリネームし、
 * ユーザーがテーマ設定や開いていたタブ、下書きノートブックなどを
 * 失わずに新バージョンへ移行できるようにする。
 */

// One-time key-rename migration: copy persisted UI state and unsaved drafts from
// the old `hue-fable-*` localStorage keys to the new `hubble-*` keys, then drop
// the old keys. Runs once on app start (before the zustand `hubble-ui` store is
// created) so an existing browser keeps its theme, open tabs and draft notebooks.
// 一度きりのキー名変更マイグレーション: 永続化された UI 状態や未保存の下書きを
// 旧 `hue-fable-*` localStorage キーから新 `hubble-*` キーへコピーし、
// 旧キーを削除する。zustand の `hubble-ui` ストアが生成される前、
// アプリ起動時に一度だけ実行されるため、既存ブラウザのユーザーは
// テーマ設定、開いていたタブ、下書きノートブックを保持したまま移行できる。

/** Old -> new key pairs for the fixed (non-prefixed) localStorage keys. */
/**
 * 固定名（接頭辞ではなく完全一致するキー）についての、旧キー名と新キー名の対応表。
 * 配列の各要素は `[旧キー, 新キー]` のタプルであり、上から順に処理される。
 */
const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['hue-fable-ui', 'hubble-ui'],
  ['hue-fable-workspace', 'hubble-workspace'],
  ['hue-fable-recent-contexts', 'hubble-recent-contexts'],
];

// 下書きノートブックのスナップショットに使われていた旧キーの接頭辞。
// 実際のキーはノートブックIDなどの動的なサフィックスが付くため、
// 固定のキー名としてではなく前方一致で列挙する必要がある。
const OLD_DRAFT_PREFIX = 'hue-fable-draft:';
// 上記に対応する新しいキーの接頭辞。
const NEW_DRAFT_PREFIX = 'hubble-draft:';

// localStorage への安全なアクセスを提供するヘルパー。
// SSR 環境やプライベートブラウジングモードなど、localStorage が
// 存在しない/アクセスできない環境でも例外を投げずに null を返す。
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Move legacy `hue-fable-*` values to their `hubble-*` equivalents. Each key is
 * copied only when the new key is absent (never clobber a newer value) and the
 * old key is always removed afterwards. No-op when localStorage is unavailable.
 *
 * 旧 `hue-fable-*` の値を、対応する新しい `hubble-*` キーへ移動する。
 * 各キーは「新キーがまだ存在しない場合のみ」コピーされる
 * （すでに新キーに値がある場合は、より新しい値を上書きしないようにするため）。
 * 旧キーはコピーの成否にかかわらず常に削除される。
 * localStorage が利用できない環境では何もしない（no-op）。
 */
export function migrateLegacyStorage(): void {
  // localStorage が使えない環境（SSR やアクセス拒否時など）では
  // 何もせずに終了する。
  const ls = safeLocalStorage();
  if (!ls) return;

  // 固定キー名のリネーム処理。
  for (const [oldKey, newKey] of RENAMES) {
    // 旧キーに値が保存されていなければ、移行対象がないのでスキップする。
    const value = ls.getItem(oldKey);
    if (value === null) continue;
    // 新キーがまだ存在しない場合のみ値をコピーする。
    // 新キーにすでに値がある場合は、それを壊さないようにコピーしない。
    if (ls.getItem(newKey) === null) ls.setItem(newKey, value);
    // コピーの成否によらず、旧キーは削除してストレージをクリーンに保つ。
    ls.removeItem(oldKey);
  }

  // Per-draft snapshots use a dynamic suffix, so enumerate the old prefix.
  // 下書きスナップショットは動的なサフィックス（例: ノートブックID）を持つため、
  // 旧接頭辞に一致するキーを localStorage 全体を走査して列挙する。
  const oldDraftKeys: string[] = [];
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (key && key.startsWith(OLD_DRAFT_PREFIX)) oldDraftKeys.push(key);
  }
  // 列挙した旧下書きキーそれぞれについて、新しい接頭辞のキーへリネームする。
  for (const oldKey of oldDraftKeys) {
    // 旧接頭辞部分を新接頭辞に置き換えて、対応する新キー名を組み立てる。
    const newKey = NEW_DRAFT_PREFIX + oldKey.slice(OLD_DRAFT_PREFIX.length);
    const value = ls.getItem(oldKey);
    if (value === null) continue;
    // 固定キーの場合と同様に、新キーが未使用の場合のみコピーする。
    if (ls.getItem(newKey) === null) ls.setItem(newKey, value);
    ls.removeItem(oldKey);
  }
}

// Run immediately on import so the migration completes before any store that
// reads `hubble-*` keys is created (main.tsx imports this first).
// このモジュールがインポートされた時点で即座に移行処理を実行する。
// こうすることで、`hubble-*` キーを読み取るいずれのストア（zustand の
// persist ミドルウェアなど）が生成されるよりも前に移行が完了する。
// main.tsx で他のどのインポートよりも先にこのモジュールを読み込むことで、
// この実行順序を保証している。
migrateLegacyStorage();

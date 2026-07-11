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

function safeGetItem(
  storage: Storage,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

function safeSetItem(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemoveItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // 移行の後処理に失敗してもアプリ起動は継続する。
  }
}

function migrateKey(storage: Storage, oldKey: string, newKey: string): void {
  const oldValue = safeGetItem(storage, oldKey);
  if (!oldValue.ok || oldValue.value === null) return;

  const newValue = safeGetItem(storage, newKey);
  if (!newValue.ok) return;
  if (newValue.value !== null) {
    safeRemoveItem(storage, oldKey);
    return;
  }

  if (safeSetItem(storage, newKey, oldValue.value)) safeRemoveItem(storage, oldKey);
}

/**
 * 旧 `hue-fable-*` の値を、対応する新しい `hubble-*` キーへ移動する。
 * 各キーは「新キーがまだ存在しない場合のみ」コピーされる
 * （すでに新キーに値がある場合は、より新しい値を上書きしないようにするため）。
 * 新キーへのコピーに成功した場合、または新キーが既に存在する場合だけ旧キーを削除する。
 * localStorage が利用できない環境では何もしない（no-op）。
 */
export function migrateLegacyStorage(): void {
  // localStorage が使えない環境（SSR やアクセス拒否時など）では
  // 何もせずに終了する。
  const ls = safeLocalStorage();
  if (!ls) return;

  // 固定キー名のリネーム処理。
  for (const [oldKey, newKey] of RENAMES) {
    migrateKey(ls, oldKey, newKey);
  }

  // Per-draft snapshots use a dynamic suffix, so enumerate the old prefix.
  // 下書きスナップショットは動的なサフィックス（例: ノートブックID）を持つため、
  // 旧接頭辞に一致するキーを localStorage 全体を走査して列挙する。
  const oldDraftKeys: string[] = [];
  try {
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (key && key.startsWith(OLD_DRAFT_PREFIX)) oldDraftKeys.push(key);
    }
  } catch {
    // キー列挙を拒否する環境では固定キーの移行だけで終了する。
    return;
  }
  // 列挙した旧下書きキーそれぞれについて、新しい接頭辞のキーへリネームする。
  for (const oldKey of oldDraftKeys) {
    // 旧接頭辞部分を新接頭辞に置き換えて、対応する新キー名を組み立てる。
    const newKey = NEW_DRAFT_PREFIX + oldKey.slice(OLD_DRAFT_PREFIX.length);
    migrateKey(ls, oldKey, newKey);
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

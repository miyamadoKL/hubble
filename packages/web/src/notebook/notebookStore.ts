// ============================================================================
// notebook 機能レイヤーの中核となる zustand ストア。
//   - 「開いている notebook 群」（TopBar のタブ）・アクティブな notebook id・
//     各 notebook の dirty（未保存変更あり）/ draft（未保存 notebook）/ saving
//     （保存 API 実行中）状態を一元管理する。
//   - セルの追加、削除、並べ替え、ソース編集、notebook のタイトル/説明/実行
//     context（datasource/catalog/schema）の変更、変数値の更新は、すべてこのストアの
//     action を通す。
//   - 永続化方針: 保存済み notebook（サーバー上に id がある = draft: false）は
//     編集のたびに 2 秒デバウンスで PUT オートセーブされる。draft notebook（まだ
//     一度もサーバーに保存されていない）は localStorage に保持し、リロードして
//     も復元できるようにする。開いているタブ集合とアクティブ id も
//     localStorage にミラーリングし、ワークスペースの状態を復元可能にする。
//   - ネットワーク呼び出しは `__setPersistence` で注入する設計にしてあるため、
//     実際の fetch なしに fake timers を使ってストアを単体テストできる。
//   - コンポーネントはファイル末尾の selector hooks（useActiveNotebook /
//     useNotebookTabs）経由で読み取る。セル実行のライフサイクル（削除時に
//     実行結果をクリアする等）は呼び出し側の責務とし、実行レイヤー
//     （execution store）への依存を持たせず循環参照を避けている。
// ============================================================================

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { z } from 'zod';
import {
  notebookStoredSchema,
  type Cell,
  type CellKind,
  type CellResultMeta,
  type ChartConfig,
  type Notebook,
  type NotebookContext,
  type Variable,
} from '@hubble/contracts';
import { uid } from '../utils/id';
import { detectVariables, reconcileVariables } from './variables';
import { readRecentContexts } from './recentContexts';
import { canPersistNotebookToServer } from '../utils/documentShare';
import { ApiClientError } from '../api/client';
import { principalStorageKey } from '../storage/principalStorage';
import { useDatasourceStore } from '../stores/datasourceStore';
import { clearRestoreAttemptsForCells } from '../execution';

// ---- 永続化の注入 --------------------------------------------------

/**
 * notebook の作成（POST 相当）と更新（PUT 相当）という、ストアが必要とする
 * ネットワーク操作だけを切り出した interface。実装は起動時に注入され、テスト
 * では fetch を使わないスタブに差し替えられる。
 */
export interface NotebookPersistence {
  create: (nb: Notebook) => Promise<Notebook>;
  update: (id: string, nb: Notebook) => Promise<Notebook>;
}

// モジュールスコープの変数に実装を保持する。React の外側（imperative な
// save ヘルパーやストアの action 内部）からも同じ実装を参照できるようにするため。
let persistence: NotebookPersistence | null = null;
/**
 * 実際の API 実装（またはテスト用スタブ）をストアに配線する。アプリ起動時に
 * 一度だけ呼び出す想定。
 */
export function __setPersistence(p: NotebookPersistence | null): void {
  persistence = p;
  if (p === null) resetPersistenceScheduling();
}

/** オートセーブのデバウンス時間（2 秒でデバウンス）。 */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

// ---- localStorage のキー ------------------------------------------------------

// ワークスペース（開いているタブ id 一覧 + アクティブ id）を保存するキー。
const WORKSPACE_KEY = principalStorageKey('hubble-workspace'); // open tab ids + active id
const WORKSPACE_BACKUP_KEY = principalStorageKey('hubble-workspace-backup');
// draft notebook 1 件ごとのスナップショットを保存するキーの接頭辞（末尾に id が付く）。
const DRAFT_PREFIX = `${principalStorageKey('hubble-draft')}:`; // per-draft notebook snapshot
const JOURNAL_PREFIX = `${principalStorageKey('hubble-notebook-journal')}:`;
const ORPHAN_DRAFT_LIMIT = 5;

// ---- 開いている notebook のレコード ---------------------------------------------------

/**
 * 「開いている」notebook 1 件分のレコード。notebook 本体（サーバー/契約層の
 * データ形）に、エディタ上の編集状態（dirty/draft/saving）を添えたもの。
 */
export interface OpenNotebook {
  notebook: Notebook;
  /** 直前の永続化以降に未保存の変更があるかどうか。 */
  dirty: boolean;
  /**
   * true の間はまだ一度もサーバーに保存されていない draft。保存後は false になり、
   * 以降は実 id を持って PUT オートセーブの対象になる。
   */
  draft: boolean;
  /** 保存 API（POST/PUT）が実行中かどうか（保存ボタンのスピナー等に使う）。 */
  saving: boolean;
  /** 競合解消まで自動保存を停止する。 */
  conflict: boolean;
  /** 保存開始後のローカル編集を識別する世代。 */
  editGeneration: number;
  /** ブラウザー内またはサーバーで永続化済みの最新編集世代。 */
  durableGeneration: number;
  /** 最新編集世代のブラウザー内永続化に失敗したかどうか。 */
  localPersistenceError: boolean;
}

// ストアが公開する state と action の全体。
interface NotebookStoreState {
  // id をキーにした「開いている notebook」の集合。並び順は持たない
  // （タブの表示順は openIds が担う）。
  open: Record<string, OpenNotebook>;
  // タブの表示順（左→右）。
  openIds: string[];
  // 現在アクティブな（前面に表示されている）notebook の id。開いている
  // notebook がなければ null。
  activeId: string | null;

  // ライフサイクル
  // notebook をタブとして開く（既に開いていれば何もしない）。
  openNotebook: (notebook: Notebook, opts?: { draft?: boolean; activate?: boolean }) => void;
  /**
   * 開いている notebook の内容をサーバー取得値で置き換える (GitHub pull 後の反映用)。
   * ローカルの編集状態 (dirty) は破棄され、保存済み状態としてリセットされる。
   * 開いていない id の場合は何もしない。
   */
  replaceNotebook: (notebook: Notebook) => void;
  // タブを閉じる。draft ならローカルの下書きも破棄し、アクティブだったタブを
  // 別のタブに付け替える。
  closeNotebook: (id: string) => void;
  // 指定した id のタブをアクティブにする。
  setActive: (id: string, opts?: { userInitiated?: boolean }) => void;
  /** タブ順を更新し、workspace snapshotへ永続化する。 */
  setOpenOrder: (openIds: string[]) => void;
  // 空の SQL セル 1 つを持つ notebook を新規 draft として開き、その id を返す。
  createBlankNotebook: () => string;

  // notebook 単位の編集
  // notebook のタイトルを変更する（空文字は "Untitled notebook" にフォールバック）。
  renameNotebook: (id: string, name: string) => void;
  // notebook の説明文を変更する。
  setDescription: (id: string, description: string) => void;
  // notebook の実行 context（catalog/schema）を変更する。
  setContext: (id: string, context: NotebookContext) => void;

  // セルの編集
  // 新しいセルを追加し、追加したセルの id を返す。position 未指定なら末尾に追加、
  // { relativeTo, where } 指定なら指定セルの上/下に挿入する。
  addCell: (
    id: string,
    kind: CellKind,
    position?: { relativeTo: string; where: 'above' | 'below' } | 'end',
  ) => string;
  // セルを削除する。
  removeCell: (id: string, cellId: string) => void;
  // セルを並べ替える（配列インデックス from → to）。
  moveCell: (id: string, from: number, to: number) => void;
  // セルの SQL/Markdown ソースを書き換える（変数の再検出のトリガーにもなる）。
  setCellSource: (id: string, cellId: string, source: string) => void;
  // セルの表示名を変更する（空欄なら未設定に戻す）。
  setCellName: (id: string, cellId: string, name: string) => void;
  // セルの折りたたみ状態をトグルする。
  toggleCellCollapsed: (id: string, cellId: string) => void;
  /** セルへ直近の実行結果サマリー（`resultMeta`）を書き込む。 */
  setCellResultMeta: (cellId: string, meta: CellResultMeta) => void;
  // セルのチャート設定を更新する（ユーザーのチャート操作のたびに呼ばれ、
  // notebook 本体と一緒にサーバーへ永続化される）。
  setCellChart: (cellId: string, chart: ChartConfig) => void;

  // 変数
  // 変数の入力値のみを更新する（SQL 自体は変わらないため変数の再検出は行わない）。
  setVariableValue: (id: string, name: string, value: string) => void;

  // 永続化
  // 保存完了後の後処理: dirty/saving をリセットし、POST で id が変わった場合は
  // タブの key を新しい id に付け替える。
  markSaved: (id: string, persisted: Notebook, savedGeneration: number) => void;
  // saving フラグだけを更新する（保存開始/失敗時のマーキングに使う）。
  setSaving: (id: string, saving: boolean) => void;
}

// ---- 純粋ヘルパー（テストから直接呼べるよう export）--------------------------------------
// ここから下は副作用のない純粋関数群。ストアの action から使われるだけでなく、
// テストからも直接呼べるよう export されている。

/**
 * 空の SQL セルを 1 つだけ持つ、まっさらな notebook を生成する
 * （初回起動時に使われる形）。id と timestamp はここで払い出す。
 */
export function blankNotebook(context: NotebookContext = {}): Notebook {
  const now = new Date().toISOString();
  return {
    id: uid('nb'),
    name: 'Untitled notebook',
    description: '',
    cells: [{ id: uid('cell'), kind: 'sql', source: '' }],
    variables: [],
    context,
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}

// 指定した種類（sql/markdown）の空セルを 1 つ生成する内部ヘルパー。
function newCell(kind: CellKind): Cell {
  return { id: uid('cell'), kind, source: '' };
}

/**
 * notebook の SQL セル群から `${name}` プレースホルダーを検出し直し、
 * `notebook.variables` を再計算する。ユーザーが既に入力済みの値は
 * `reconcileVariables` 側で名前が一致するものを引き継ぐため失われない。
 * セルのソースを編集するたびに呼ばれる。
 */
export function recomputeVariables(notebook: Notebook): Variable[] {
  const sqlSources = notebook.cells.filter((c) => c.kind === 'sql').map((c) => c.source);
  const detected = detectVariables(sqlSources);
  return reconcileVariables(detected, notebook.variables);
}

/**
 * 配列の要素を `from` の位置から `to` の位置へ移動した「新しい」配列を返す
 * （元の配列は変更しない）。範囲外の index は no-op として無視する。
 * セルの並べ替え（moveCell）で使われる。
 */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = arr.slice();
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

// ---- draft とワークスペースの永続化（localStorage）---------------------------
// リロード後の復元用に、ワークスペース（開いているタブ構成）と draft notebook
// の中身を localStorage に書き出す/読み戻すための一群の関数。

/** localStorageに保存するワークスペースのスナップショット形。 */
export interface WorkspaceSnapshot {
  version: 1;
  openIds: string[];
  activeId: string | null;
  /** 開いている id のうち draft であるものの一覧（DRAFT_PREFIX から読むべき対象の判定に使う）。 */
  draftIds: string[];
}

// 復元待ちのIDを通常操作によるworkspace書き込みへ合流させる。
let pendingWorkspaceRestore: {
  snapshot: WorkspaceSnapshot;
  unresolvedIds: Set<string>;
} | null = null;
let workspaceActivationGeneration = 0;

const workspaceSnapshotSchema = z.object({
  version: z.literal(1),
  openIds: z.array(z.string()),
  activeId: z.string().nullable(),
  draftIds: z.array(z.string()),
});

const workspaceDraftIdsSchema = z.object({ draftIds: z.array(z.string()) });

// SSR やプライベートブラウジング等で localStorage が使えない環境でも例外で
// 落ちないようにするためのガード付きアクセサ。
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// 現在の openIds / activeId / draft か否かを localStorage に書き出す。
// タブの開閉や切り替えのたびに呼ばれる。
function writeWorkspace(state: NotebookStoreState): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  const currentDraftIds = state.openIds.filter((id) => state.open[id]?.draft);
  const openIds = pendingWorkspaceRestore
    ? mergeUnresolvedIds(
        state.openIds,
        pendingWorkspaceRestore.snapshot.openIds,
        pendingWorkspaceRestore.unresolvedIds,
      )
    : state.openIds;
  const draftIds = pendingWorkspaceRestore
    ? mergeUnresolvedIds(
        currentDraftIds,
        pendingWorkspaceRestore.snapshot.draftIds,
        pendingWorkspaceRestore.unresolvedIds,
      )
    : currentDraftIds;
  const pendingActiveId = pendingWorkspaceRestore?.snapshot.activeId;
  const snapshot: WorkspaceSnapshot = {
    version: 1,
    openIds,
    activeId:
      pendingActiveId && pendingWorkspaceRestore?.unresolvedIds.has(pendingActiveId)
        ? pendingActiveId
        : state.activeId,
    draftIds,
  };
  try {
    ls.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    /* quota 超過やシリアライズ失敗は致命的ではないため無視する */
    return false;
  }
}

/** 現在順を崩さず、未解決IDを元snapshot内の近い位置へ挿入する。 */
function mergeUnresolvedIds(
  currentIds: readonly string[],
  snapshotIds: readonly string[],
  unresolvedIds: ReadonlySet<string>,
): string[] {
  let merged = [...currentIds];
  for (const id of snapshotIds) {
    if (!unresolvedIds.has(id) || merged.includes(id)) continue;
    merged = insertIdAtSnapshotPosition(merged, id, snapshotIds);
  }
  return merged;
}

/** IDをsnapshot内の近い前後関係に合わせて現在順へ挿入する。 */
export function insertIdAtSnapshotPosition(
  currentIds: readonly string[],
  id: string,
  snapshotIds: readonly string[],
): string[] {
  const without = currentIds.filter((currentId) => currentId !== id);
  const snapshotIndex = snapshotIds.indexOf(id);
  let insertAt = without.length;
  for (let index = snapshotIndex - 1; index >= 0; index -= 1) {
    const previous = without.indexOf(snapshotIds[index]!);
    if (previous >= 0) {
      insertAt = previous + 1;
      break;
    }
  }
  if (insertAt === without.length) {
    for (let index = snapshotIndex + 1; index < snapshotIds.length; index += 1) {
      const next = without.indexOf(snapshotIds[index]!);
      if (next >= 0) {
        insertAt = next;
        break;
      }
    }
  }
  without.splice(insertAt, 0, id);
  return without;
}

/** workspace復元中に保持すべきIDを登録する。 */
export function beginWorkspaceRestore(snapshot: WorkspaceSnapshot): void {
  pendingWorkspaceRestore = {
    snapshot: {
      ...snapshot,
      openIds: [...snapshot.openIds],
      draftIds: [...snapshot.draftIds],
    },
    unresolvedIds: new Set(snapshot.openIds),
  };
}

/** 指定IDが現在も復元待ちかを返す。 */
export function isWorkspaceRestorePending(id: string): boolean {
  return pendingWorkspaceRestore?.unresolvedIds.has(id) ?? false;
}

/** ユーザーがactive tabを変更した世代を返す。 */
export function getWorkspaceActivationGeneration(): number {
  return workspaceActivationGeneration;
}

/** 復元待ち集合から指定IDを除く。永続化は呼び出し側が行う。 */
function removeWorkspaceRestoreId(id: string): void {
  if (!pendingWorkspaceRestore) return;
  pendingWorkspaceRestore.unresolvedIds.delete(id);
  if (pendingWorkspaceRestore.unresolvedIds.size === 0) pendingWorkspaceRestore = null;
}

/** 成功または恒久欠落が確定したIDを復元待ち集合から外す。 */
export function resolveWorkspaceRestoreId(id: string): void {
  removeWorkspaceRestoreId(id);
  writeWorkspace(useNotebookStore.getState());
}

/** 保存済みnotebookの未反映編集を保持するlocal journal。 */
export interface NotebookJournal {
  version: 1;
  id: string;
  baseRevision: number;
  editGeneration: number;
  notebook: Notebook;
}

const notebookJournalSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    baseRevision: z.number().int().nonnegative(),
    editGeneration: z.number().int().nonnegative(),
    notebook: notebookStoredSchema,
  })
  .refine(
    (journal) =>
      journal.notebook.id === journal.id && journal.notebook.revision === journal.baseRevision,
  );

type JournalReadResult =
  | { kind: 'valid'; journal: NotebookJournal }
  | { kind: 'corrupt' }
  | { kind: 'missing' };

// draft notebook 1 件の中身をまるごと localStorage に書き出す（編集のたびに
// 呼ばれ、これがそのまま「draft のオートセーブ」の実体になる）。
function writeDraft(notebook: Notebook): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(`${DRAFT_PREFIX}${notebook.id}`, JSON.stringify(notebook));
    return true;
  } catch {
    /* 保存失敗は致命的でないため握りつぶす */
    return false;
  }
}

/** 保存済みnotebookの現在世代をlocal journalへ同期書き込みする。 */
function writeNotebookJournal(entry: OpenNotebook): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  const journal: NotebookJournal = {
    version: 1,
    id: entry.notebook.id,
    baseRevision: entry.notebook.revision,
    editGeneration: entry.editGeneration,
    notebook: entry.notebook,
  };
  try {
    ls.setItem(`${JOURNAL_PREFIX}${journal.id}`, JSON.stringify(journal));
    return true;
  } catch {
    return false;
  }
}

/** 指定notebookのlocal journalを検証して読み出す。 */
function readNotebookJournal(id: string): JournalReadResult {
  const ls = safeLocalStorage();
  if (!ls) return { kind: 'missing' };
  const raw = ls.getItem(`${JOURNAL_PREFIX}${id}`);
  if (!raw) return { kind: 'missing' };
  try {
    const parsed = notebookJournalSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.id === id) {
      return { kind: 'valid', journal: parsed.data };
    }
  } catch {
    // JSONとして壊れているjournalも破損状態として扱い、rawは残す。
  }
  return { kind: 'corrupt' };
}

/** 対応世代のCAS成功後だけlocal journalを削除する。 */
function removeNotebookJournal(id: string, savedGeneration?: number): boolean {
  const ls = safeLocalStorage();
  if (!ls) return true;
  const key = `${JOURNAL_PREFIX}${id}`;
  if (savedGeneration !== undefined) {
    const current = readNotebookJournal(id);
    if (current.kind === 'corrupt') return false;
    if (current.kind === 'valid' && current.journal.editGeneration > savedGeneration) return true;
  }
  try {
    ls.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// draft のスナップショットを削除する（タブを閉じた時、保存が完了して正式な
// notebook になった時に呼ばれる）。
function removeDraft(id: string): void {
  try {
    safeLocalStorage()?.removeItem(`${DRAFT_PREFIX}${id}`);
  } catch {
    // サーバー保存後の削除失敗はnotebook本体の永続化結果へ影響しない。
  }
}

type DraftReadResult =
  | { kind: 'valid'; draft: Notebook }
  | { kind: 'corrupt' }
  | { kind: 'missing' };

// draft notebook 1件をlocalStorageから読み戻し、3状態へ分類する。
function readDraft(id: string): DraftReadResult {
  const ls = safeLocalStorage();
  if (!ls) return { kind: 'missing' };
  const raw = ls.getItem(`${DRAFT_PREFIX}${id}`);
  if (!raw) return { kind: 'missing' };
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = notebookStoredSchema.safeParse(value);
    if (parsed.success && parsed.data.id === id) return { kind: 'valid', draft: parsed.data };
  } catch {
    // JSONとして壊れている場合も破損状態として扱う。
  }
  return { kind: 'corrupt' };
}

/** snapshotから参照されないdraft rawを新しい順に上限件数だけ残す。 */
function cleanupOrphanDrafts(storage: Storage, referencedIds: ReadonlySet<string>): void {
  const orphans: { key: string; timestamp: number; order: number }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    const id = key.slice(DRAFT_PREFIX.length);
    if (referencedIds.has(id)) continue;
    let timestamp = Number.MAX_SAFE_INTEGER;
    try {
      const value: unknown = JSON.parse(storage.getItem(key) ?? 'null');
      if (value && typeof value === 'object' && 'updatedAt' in value) {
        const parsedTimestamp = Date.parse(String(value.updatedAt));
        timestamp = Number.isNaN(parsedTimestamp) ? Number.MAX_SAFE_INTEGER : parsedTimestamp;
      }
    } catch {
      // 破損rawは直前起動で外された可能性があるため最新として扱う。
    }
    orphans.push({ key, timestamp, order: index });
  }
  orphans
    .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order)
    .slice(0, Math.max(0, orphans.length - ORPHAN_DRAFT_LIMIT))
    .forEach(({ key }) => storage.removeItem(key));
}

/** draft復元結果と、破損して復元対象から外したIDを返す。 */
export interface DraftRestoreResult {
  drafts: Notebook[];
  corruptIds: string[];
  snapshot: WorkspaceSnapshot | null;
}

/**
 * 永続化済みのワークスペーススナップショット（開いていたタブ id 群 +
 * アクティブ id）を読み出す。何もなければ null。アプリ起動時の復元に使う。
 */
export function readWorkspaceSnapshot(): WorkspaceSnapshot | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  const raw = ls.getItem(WORKSPACE_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = workspaceSnapshotSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    backupWorkspaceRaw(ls, raw);
    return null;
  } catch {
    backupWorkspaceRaw(ls, raw);
    return null;
  }
}

/** 解釈不能なworkspaceの直近内容を退避する。 */
function backupWorkspaceRaw(storage: Storage, raw: string): void {
  try {
    storage.setItem(WORKSPACE_BACKUP_KEY, raw);
  } catch {
    // backup不能でも既存snapshotの読み取り結果はnullとして扱う。
  }
}

/** workspace backupが参照するdraft IDを読み取る。 */
function readBackupDraftIds(storage: Storage): string[] {
  try {
    const raw = storage.getItem(WORKSPACE_BACKUP_KEY);
    if (!raw) return [];
    const parsed = workspaceDraftIdsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.draftIds : [];
  } catch {
    return [];
  }
}

/**
 * ワークスペーススナップショットに記録された draft id のうち、
 * 復元可能なもの（localStorage に実体が残っているもの）をすべて読み出す。
 */
export function readDrafts(): Notebook[] {
  return readDraftRestoreResult().drafts;
}

/** 復元可能なdraftと、rawを元キーに残した破損draft IDを返す。 */
export function readDraftRestoreResult(snapshot = readWorkspaceSnapshot()): DraftRestoreResult {
  if (!snapshot) {
    return { drafts: [], corruptIds: [], snapshot: null };
  }
  const storage = safeLocalStorage();
  if (storage) {
    const referencedIds = new Set(snapshot.draftIds);
    for (const id of readBackupDraftIds(storage)) referencedIds.add(id);
    cleanupOrphanDrafts(storage, referencedIds);
  }
  const drafts: Notebook[] = [];
  const corruptIds: string[] = [];
  const removedIds = new Set<string>();
  for (const id of snapshot.draftIds) {
    const result = readDraft(id);
    if (result.kind === 'valid') drafts.push(result.draft);
    else {
      removedIds.add(id);
      if (result.kind === 'corrupt') corruptIds.push(id);
    }
  }
  const restoredSnapshot =
    removedIds.size === 0
      ? snapshot
      : {
          ...snapshot,
          openIds: snapshot.openIds.filter((id) => !removedIds.has(id)),
          draftIds: snapshot.draftIds.filter((id) => !removedIds.has(id)),
          activeId:
            snapshot.activeId && removedIds.has(snapshot.activeId) ? null : snapshot.activeId,
        };
  if (restoredSnapshot !== snapshot) {
    try {
      safeLocalStorage()?.setItem(WORKSPACE_KEY, JSON.stringify(restoredSnapshot));
    } catch {
      // 破損rawは元キーに残るため、workspace更新失敗だけを非致命として扱う。
    }
  }
  return { drafts, corruptIds, snapshot: restoredSnapshot };
}

// ---- オートセーブのスケジューリング ----------------------------------------------------

// notebook ごとのデバウンス timer は reactive なストアの外に持つ。
// 保存のスケジューリング自体が再レンダーを起こさないようにするため。
// notebook id → デバウンス用 timer のマップ。zustand の state に入れず
// モジュールスコープに置くことで、timer のスケジューリング自体が再レンダーの
// トリガーにならないようにしている。
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface SaveWaiter {
  generation: number;
  resolve: (saved: Notebook | null) => void;
}

interface SaveCoordinator {
  running: boolean;
  cancelled: boolean;
  rebaseOnCompletion: boolean;
  waiters: SaveWaiter[];
}

// notebook単位の保存調停器をモジュールスコープに置き、オートセーブと明示保存を
// 同じsingle-flightへ合流させる。
const saveCoordinators = new Map<string, SaveCoordinator>();
const notebookUpdateTails = new Map<string, Promise<void>>();

// 保留中のオートセーブ timer を取り消す（保存が完了した時、閉じられた時、
// 新しい編集で timer をリセットする時に呼ばれる）。
function clearAutosave(id: string): void {
  const t = autosaveTimers.get(id);
  if (t) {
    clearTimeout(t);
    autosaveTimers.delete(id);
  }
}

/** 閉じるまたは外部置換されたnotebookの保存調停器を無効化する。 */
function cancelSavedNotebookQueue(id: string, rebaseOnCompletion: boolean): void {
  const coordinator = saveCoordinators.get(id);
  if (!coordinator) return;
  coordinator.cancelled = true;
  coordinator.rebaseOnCompletion = rebaseOnCompletion;
  for (const waiter of coordinator.waiters) waiter.resolve(null);
  coordinator.waiters = [];
  if (saveCoordinators.get(id) === coordinator) saveCoordinators.delete(id);
}

/** テスト用の永続化差し替え時にtimerと調停器を初期化する。 */
function resetPersistenceScheduling(): void {
  for (const timer of autosaveTimers.values()) clearTimeout(timer);
  autosaveTimers.clear();
  for (const coordinator of saveCoordinators.values()) {
    coordinator.cancelled = true;
    coordinator.rebaseOnCompletion = false;
    for (const waiter of coordinator.waiters) waiter.resolve(null);
  }
  saveCoordinators.clear();
}

// ---- ストア本体 ------------------------------------------------------------------

export const useNotebookStore = create<NotebookStoreState>((set, get) => {
  // mutate / afterChange / scheduleAutosave / saveNow は、ほぼすべての
  // notebook 編集 action から呼ばれる共通の下請け関数群。
  // 「notebook を書き換える → 変数を再計算する → dirty にする →
  //  永続化をトリガーする」という一連の流れを 1 箇所にまとめている。
  //
  // この mutate を「純粋な編集」と「保存の調停(persistence、autosave timer、
  // saveCoordinators)」に分離しない。分離しても persistence、restore state、
  // timer、save coordinator、update tail、Zustand store、StrictMode latch の
  // state owner を一つも減らせず、updatedAt、変数再計算、dirty と
  // editGeneration、draft journal、saved autosave、resultMeta の touch なし
  // 更新を維持するには I/O 境界を別 helper に再実装する必要がある。保守的な
  // 正味削減上限の見積もりは 60 実装行未満、実際には 30 行未満に留まった。

  /** 開いているnotebookを更新し、変数再計算後に未保存状態へ移す。 */
  const mutate = (
    id: string,
    fn: (nb: Notebook) => Notebook,
    opts: { touch?: boolean } = {},
  ): void => {
    const entry = get().open[id];
    if (!entry) return;
    let next = fn(entry.notebook);
    // SQL セルの中身が変わった可能性があるので、変数プレースホルダーを
    // 検出し直して notebook.variables を最新化する。
    next = { ...next, variables: recomputeVariables(next) };
    // touch: false が明示されない限り updatedAt を更新する（ユーザーの
    // 実質的な編集とみなす）。
    if (opts.touch !== false) next = { ...next, updatedAt: new Date().toISOString() };
    set((s) => ({
      open: {
        ...s.open,
        [id]: { ...entry, notebook: next, dirty: true, editGeneration: entry.editGeneration + 1 },
      },
    }));
    afterChange(id);
  };

  /** 同期書き込みの成否を、対象編集世代が最新の場合だけ状態へ反映する。 */
  const recordLocalPersistence = (id: string, generation: number, succeeded: boolean): void => {
    set((state) => {
      const current = state.open[id];
      if (!current || current.editGeneration !== generation) return state;
      return {
        open: {
          ...state.open,
          [id]: {
            ...current,
            durableGeneration: succeeded
              ? Math.max(current.durableGeneration, generation)
              : current.durableGeneration,
            localPersistenceError: !succeeded,
          },
        },
      };
    });
  };

  /** 編集後にブラウザーへ同期保存し、保存済みならPUTも予約する。 */
  const afterChange = (id: string): void => {
    const entry = get().open[id];
    if (!entry) return;
    const contentPersisted = entry.draft ? writeDraft(entry.notebook) : writeNotebookJournal(entry);
    const workspacePersisted = writeWorkspace(get());
    recordLocalPersistence(id, entry.editGeneration, contentPersisted && workspacePersisted);
    if (entry.draft) {
      // draft はサーバーに保存先がないので localStorage への書き出しだけ行う。
      // draftはサーバーに保存先がないため、同期書き込みの結果だけを状態へ反映する。
      return;
    } else if (
      !entry.conflict &&
      canPersistNotebookToServer({ draft: false, myPermission: entry.notebook.myPermission })
    ) {
      // 保存済み notebook はデバウンスして PUT する（view 共有はスキップ）。
      scheduleAutosave(id);
    }
  };

  /** 保存済み notebook 用のデバウンス PUT（2 秒デバウンス）。 */
  const scheduleAutosave = (id: string): void => {
    // 直前の timer を破棄してから新しく張り直す = 連続編集中は PUT が
    // 発火しない（最後の編集から 2 秒静止して初めて保存される）。
    clearAutosave(id);
    const timer = setTimeout(() => {
      autosaveTimers.delete(id);
      void requestSavedNotebookSave(id);
    }, AUTOSAVE_DEBOUNCE_MS);
    autosaveTimers.set(id, timer);
  };

  return {
    open: {},
    openIds: [],
    activeId: null,

    openNotebook: (notebook, opts = {}) => {
      const { draft = false, activate = true } = opts;
      // 既に開いていれば editing state（dirty/draft/saving）を維持したまま
      // 何もしない（＝二重に開いても上書きしない）。
      const existing = get().open[notebook.id];
      const journalResult = !draft && !existing ? readNotebookJournal(notebook.id) : null;
      const journal = journalResult?.kind === 'valid' ? journalResult.journal : null;
      const restoredNotebook = journal
        ? {
            ...journal.notebook,
            owner: notebook.owner,
            myPermission: notebook.myPermission,
          }
        : notebook;
      const journalConflict = journal !== null && journal.baseRevision !== notebook.revision;
      set((s) => {
        const open = {
          ...s.open,
          [notebook.id]: existing
            ? { ...existing }
            : {
                notebook: restoredNotebook,
                dirty: journal !== null,
                draft,
                saving: false,
                conflict: journalConflict,
                editGeneration: journal?.editGeneration ?? 0,
                durableGeneration: journal?.editGeneration ?? 0,
                localPersistenceError: journalResult?.kind === 'corrupt',
              },
        };
        const openIds = s.openIds.includes(notebook.id) ? s.openIds : [...s.openIds, notebook.id];
        return {
          open,
          openIds,
          // activate: false の場合でも、まだ何も開かれていなければ最初の
          // notebook をアクティブにする（アクティブが空のままにならないように）。
          activeId: activate ? notebook.id : (s.activeId ?? notebook.id),
        };
      });
      if (activate) workspaceActivationGeneration += 1;
      // 手動操作を含め、openになったIDは復元成功と同じく未解決集合から外す。
      removeWorkspaceRestoreId(notebook.id);
      const workspacePersisted = writeWorkspace(get());
      if (!workspacePersisted) {
        const current = get().open[notebook.id];
        if (current) recordLocalPersistence(notebook.id, current.editGeneration, false);
      }
      if (
        journal &&
        !journalConflict &&
        canPersistNotebookToServer({ draft: false, myPermission: notebook.myPermission })
      ) {
        scheduleAutosave(notebook.id);
      }
    },

    replaceNotebook: (notebook) => {
      const existing = get().open[notebook.id];
      if (!existing) return;
      // 保留中のオートセーブがあれば取り消す (古い内容を PUT しないため)。
      clearAutosave(notebook.id);
      cancelSavedNotebookQueue(notebook.id, false);
      // 差し替えで消える旧セル（新しい cells 集合に存在しない id）の分だけ、
      // 結果自動復元の試行済み記録も一緒に寿命を終える（指摘: replaceNotebook で
      // 消えるセルの記録が回収されていなかった）。
      const nextCellIds = new Set(notebook.cells.map((c) => c.id));
      const removedCellIds = existing.notebook.cells
        .map((c) => c.id)
        .filter((cellId) => !nextCellIds.has(cellId));
      if (removedCellIds.length > 0) clearRestoreAttemptsForCells(removedCellIds);
      set((s) => ({
        open: {
          ...s.open,
          [notebook.id]: {
            notebook,
            dirty: false,
            draft: false,
            saving: false,
            conflict: false,
            editGeneration: 0,
            durableGeneration: 0,
            localPersistenceError: false,
          },
        },
      }));
      removeNotebookJournal(notebook.id);
    },

    closeNotebook: (id) => {
      // 閉じるタブに保留中のオートセーブがあれば取り消す。
      clearAutosave(id);
      cancelSavedNotebookQueue(id, true);
      const entry = get().open[id];
      // draft なら localStorage 上の下書きも一緒に消す（復元されないように）。
      if (entry?.draft) removeDraft(id);
      else removeNotebookJournal(id);
      // このnotebookのセルに紐づく「結果自動復元の試行済み」記録
      // （execution レイヤーのモジュールレベル集合）も、notebook を閉じたら
      // 一緒に寿命を終える。消さないと、二度と開かれない notebook のセルの
      // 分だけ記録が無制限に増え続けてしまう。
      if (entry) clearRestoreAttemptsForCells(entry.notebook.cells.map((c) => c.id));
      const previousActiveId = get().activeId;
      set((s) => {
        const open = { ...s.open };
        delete open[id];
        const openIds = s.openIds.filter((x) => x !== id);
        let activeId = s.activeId;
        if (activeId === id) {
          // 閉じたタブがアクティブだった場合、同じ位置（末尾なら 1 つ手前）の
          // タブへアクティブを付け替える。
          const idx = s.openIds.indexOf(id);
          activeId = openIds[Math.min(idx, openIds.length - 1)] ?? null;
        }
        return { open, openIds, activeId };
      });
      // ユーザーが明示的に閉じたIDは復元保護の対象からも外す。
      removeWorkspaceRestoreId(id);
      if (get().activeId !== previousActiveId) workspaceActivationGeneration += 1;
      writeWorkspace(get());
    },

    setActive: (id, opts = {}) => {
      // 開かれていない id は無視する。
      if (!get().open[id]) return;
      if (opts.userInitiated !== false && get().activeId !== id) {
        workspaceActivationGeneration += 1;
      }
      set({ activeId: id });
      writeWorkspace(get());
    },

    setOpenOrder: (openIds) => {
      set({ openIds });
      writeWorkspace(get());
    },

    createBlankNotebook: () => {
      // アクティブな notebook が実行contextを持っていればそれを引き継ぎ、
      // 持っていなければ現在のデータソースに対応する直近contextを使う。
      const active = get().activeId ? get().open[get().activeId!]?.notebook.context : undefined;
      const selected = useDatasourceStore.getState().executionContext;
      const activeWithDatasource =
        active && (active.datasourceId || active.catalog || active.schema)
          ? { ...active, datasourceId: active.datasourceId ?? selected.datasourceId }
          : undefined;
      const recent = selected.datasourceId
        ? readRecentContexts(selected.datasourceId)[0]
        : undefined;
      const ctx = activeWithDatasource ?? recent ?? selected;
      const nb = blankNotebook(ctx);
      get().openNotebook(nb, { draft: true, activate: true });
      const contentPersisted = writeDraft(nb);
      const workspacePersisted = writeWorkspace(get());
      recordLocalPersistence(nb.id, 0, contentPersisted && workspacePersisted);
      return nb.id;
    },

    renameNotebook: (id, name) => {
      // 空欄（trim 後に空文字）ならデフォルト名にフォールバックする。
      mutate(id, (nb) => ({ ...nb, name: name.trim() || 'Untitled notebook' }));
    },

    setDescription: (id, description) => {
      mutate(id, (nb) => ({ ...nb, description }));
    },

    setContext: (id, context) => {
      mutate(id, (nb) => ({ ...nb, context }));
    },

    addCell: (id, kind, position = 'end') => {
      const cell = newCell(kind);
      mutate(id, (nb) => {
        if (position === 'end') return { ...nb, cells: [...nb.cells, cell] };
        const idx = nb.cells.findIndex((c) => c.id === position.relativeTo);
        // 基準セルが見つからない場合は安全側に倒して末尾へ追加する。
        if (idx === -1) return { ...nb, cells: [...nb.cells, cell] };
        const at = position.where === 'above' ? idx : idx + 1;
        const cells = nb.cells.slice();
        cells.splice(at, 0, cell);
        return { ...nb, cells };
      });
      // 呼び出し側（例: 挿入直後にフォーカスを当てる処理）が使えるよう、
      // 新規セルの id を返す。
      return cell.id;
    },

    removeCell: (id, cellId) => {
      mutate(id, (nb) => ({ ...nb, cells: nb.cells.filter((c) => c.id !== cellId) }));
      // 削除したセルに紐づく結果自動復元の試行済み記録も一緒に消す（指摘:
      // removeCell は配列から除くだけで、closeNotebook が列挙するのは残存
      // セルのみのため、削除済みセルの記録が回収されずに残ってしまっていた）。
      clearRestoreAttemptsForCells([cellId]);
    },

    moveCell: (id, from, to) => {
      mutate(id, (nb) => ({ ...nb, cells: moveItem(nb.cells, from, to) }));
    },

    setCellSource: (id, cellId, source) => {
      mutate(id, (nb) => ({
        ...nb,
        cells: nb.cells.map((c) => (c.id === cellId ? { ...c, source } : c)),
      }));
    },

    setCellName: (id, cellId, name) => {
      mutate(id, (nb) => ({
        ...nb,
        cells: nb.cells.map((c) =>
          c.id === cellId ? { ...c, name: name.trim() ? name : undefined } : c,
        ),
      }));
    },

    toggleCellCollapsed: (id, cellId) => {
      mutate(id, (nb) => ({
        ...nb,
        cells: nb.cells.map((c) => (c.id === cellId ? { ...c, collapsed: !c.collapsed } : c)),
      }));
    },

    setCellResultMeta: (cellId, meta) => {
      // このセルを所有する notebook を探す（cellId はグローバルに一意）。
      // cellId から notebook id への逆引きインデックスは持っていないため、
      // 開いている全 notebook のセルを線形探索して所有者を探す。
      const state = get();
      const ownerId = state.openIds.find((nbId) =>
        state.open[nbId]?.notebook.cells.some((c) => c.id === cellId),
      );
      if (!ownerId) return;
      const entry = state.open[ownerId];
      if (!entry) return;
      const cells = entry.notebook.cells.map((c) =>
        c.id === cellId ? { ...c, resultMeta: meta } : c,
      );
      // （resultMeta は実行結果から派生する情報であり、ユーザーが入力した
      // コンテンツではないため updatedAt や変数再計算の対象にはしない。
      // ただし dirty にはするので、次回の保存には一緒に乗る。）
      const next = { ...entry.notebook, cells };
      set((s) => ({
        open: {
          ...s.open,
          [ownerId]: {
            ...entry,
            notebook: next,
            dirty: true,
            editGeneration: entry.editGeneration + 1,
          },
        },
      }));
      afterChange(ownerId);
    },

    setCellChart: (cellId, chart) => {
      // setCellResultMeta と同様、cellId から所有 notebook を線形探索で逆引きする。
      const state = get();
      const ownerId = state.openIds.find((nbId) =>
        state.open[nbId]?.notebook.cells.some((c) => c.id === cellId),
      );
      if (!ownerId) return;
      // チャート設定はユーザーが編集するコンテンツなので mutate 経由で
      // updatedAt を更新し、通常のオートセーブフローに乗せる
      // （SQL は変わらないが mutate の変数再計算は冪等なので問題ない）。
      mutate(ownerId, (nb) => ({
        ...nb,
        cells: nb.cells.map((c) => (c.id === cellId ? { ...c, chart } : c)),
      }));
    },

    setVariableValue: (id, name, value) => {
      // 値の変更は SQL 自体を変えないため、変数の再検出はスキップし、
      // 一致する変数の値だけを更新する。
      // （`mutate` を使わず直接 set しているのは、変数の再検出が不要な
      // 軽量パスであることを明示するため。）
      const entry = get().open[id];
      if (!entry) return;
      const variables = entry.notebook.variables.map((v) =>
        v.name === name ? { ...v, value } : v,
      );
      const next = {
        ...entry.notebook,
        variables,
        updatedAt: new Date().toISOString(),
      };
      set((s) => ({
        open: {
          ...s.open,
          [id]: {
            ...entry,
            notebook: next,
            dirty: true,
            editGeneration: entry.editGeneration + 1,
          },
        },
      }));
      afterChange(id);
    },

    markSaved: (id, persisted, savedGeneration) => {
      const entry = get().open[id];
      if (!entry) return;
      const wasDraft = entry.draft;
      const editedDuringSave = entry.editGeneration !== savedGeneration;
      if (!editedDuringSave) clearAutosave(id);
      // draft の初回保存（POST）ではサーバーが新しい id を発行するため、
      // open/openIds/activeId すべてでキーを古い id → 新しい id に付け替える。
      const newKey = persisted.id;
      set((s) => {
        const open = { ...s.open };
        delete open[id];
        open[newKey] = editedDuringSave
          ? {
              ...entry,
              notebook: { ...entry.notebook, id: newKey, revision: persisted.revision },
              dirty: true,
              draft: false,
              saving: false,
              durableGeneration: Math.max(entry.durableGeneration, savedGeneration),
            }
          : {
              notebook: persisted,
              dirty: false,
              draft: false,
              saving: false,
              conflict: false,
              editGeneration: savedGeneration,
              durableGeneration: savedGeneration,
              localPersistenceError: false,
            };
        const openIds = s.openIds.map((x) => (x === id ? newKey : x));
        const activeId = s.activeId === id ? newKey : s.activeId;
        return { open, openIds, activeId };
      });
      const current = get().open[newKey];
      let contentPersisted = true;
      if (editedDuringSave && current) {
        // 保存開始後の編集は新revisionをbaseにjournalを書き直してから次のPUTへ渡す。
        contentPersisted = writeNotebookJournal(current);
      } else if (!wasDraft) {
        // 対応世代のCASが成功した場合だけ、その世代のjournalを削除する。
        contentPersisted = removeNotebookJournal(id, savedGeneration);
      }
      // re-key後の本文を先に保存できた場合だけworkspaceの参照先を更新する。
      const workspacePersisted = contentPersisted && writeWorkspace(get());
      const localPersisted = contentPersisted && workspacePersisted;
      if (wasDraft && localPersisted) {
        // draft から昇格したので、もう localStorage の下書きは不要。
        // draft昇格後は、本文とworkspaceを新idで保存できた場合だけ旧rawを削除する。
        removeDraft(id);
      }
      if (current) {
        set((state) => {
          const latest = state.open[newKey];
          if (!latest || latest.editGeneration !== current.editGeneration) return state;
          return {
            open: {
              ...state.open,
              [newKey]: {
                ...latest,
                durableGeneration: localPersisted
                  ? Math.max(latest.durableGeneration, latest.editGeneration)
                  : Math.max(latest.durableGeneration, savedGeneration),
                localPersistenceError: !localPersisted,
              },
            },
          };
        });
      }
      if (editedDuringSave) scheduleAutosave(newKey);
    },

    setSaving: (id, saving) => {
      const entry = get().open[id];
      if (!entry) return;
      set((s) => ({ open: { ...s.open, [id]: { ...entry, saving } } }));
    },
  };
});

/** 指定世代までを待つ呼び出し元へ保存結果を通知する。 */
function settleSaveWaiters(
  coordinator: SaveCoordinator,
  generation: number,
  saved: Notebook | null,
): void {
  const remaining: SaveWaiter[] = [];
  for (const waiter of coordinator.waiters) {
    if (waiter.generation <= generation) waiter.resolve(saved);
    else remaining.push(waiter);
  }
  coordinator.waiters = remaining;
}

/** notebook単位のsingle-flightへ保存要求を追加する。 */
function requestSavedNotebookSave(id: string): Promise<Notebook | null> {
  const entry = useNotebookStore.getState().open[id];
  if (
    !persistence ||
    !entry ||
    entry.draft ||
    entry.conflict ||
    !canPersistNotebookToServer({ draft: false, myPermission: entry.notebook.myPermission })
  ) {
    return Promise.resolve(null);
  }
  if (!entry.dirty) return Promise.resolve(entry.notebook);

  let coordinator = saveCoordinators.get(id);
  if (!coordinator) {
    coordinator = { running: false, cancelled: false, rebaseOnCompletion: false, waiters: [] };
    saveCoordinators.set(id, coordinator);
  }
  const result = new Promise<Notebook | null>((resolve) => {
    coordinator!.waiters.push({ generation: entry.editGeneration, resolve });
  });
  if (!coordinator.running) {
    coordinator.running = true;
    void runSavedNotebookQueue(id, coordinator);
  }
  return result;
}

/** 同じnotebook IDのHTTP PUTを開始順に一件ずつ実行する。 */
async function withNotebookUpdateTurn<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = notebookUpdateTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  notebookUpdateTails.set(id, turn);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (notebookUpdateTails.get(id) === turn) notebookUpdateTails.delete(id);
  }
}

/** 閉じる前のPUT成功を、同じIDで開き直した編集のbase revisionへ反映する。 */
function rebaseReopenedNotebook(id: string, baseRevision: number, saved: Notebook): void {
  const current = useNotebookStore.getState().open[id];
  if (!current || current.draft || current.notebook.revision !== baseRevision) return;
  const next: OpenNotebook = current.dirty
    ? {
        ...current,
        notebook: { ...current.notebook, revision: saved.revision },
        saving: false,
      }
    : {
        ...current,
        notebook: saved,
        saving: false,
      };
  useNotebookStore.setState((state) => ({ open: { ...state.open, [id]: next } }));
  if (!next.dirty) return;
  const contentPersisted = writeNotebookJournal(next);
  const workspacePersisted = writeWorkspace(useNotebookStore.getState());
  useNotebookStore.setState((state) => {
    const latest = state.open[id];
    if (!latest || latest !== next) return state;
    const localPersisted = contentPersisted && workspacePersisted;
    return {
      open: {
        ...state.open,
        [id]: {
          ...latest,
          durableGeneration: localPersisted
            ? Math.max(latest.durableGeneration, latest.editGeneration)
            : latest.durableGeneration,
          localPersistenceError: !localPersisted,
        },
      },
    };
  });
}

/** 調停器に蓄積した最新世代を直列保存し、中間世代をまとめる。 */
async function runSavedNotebookQueue(id: string, coordinator: SaveCoordinator): Promise<void> {
  while (!coordinator.cancelled) {
    const shouldContinue = await withNotebookUpdateTurn(id, async () => {
      if (coordinator.cancelled) return false;
      const entry = useNotebookStore.getState().open[id];
      const activePersistence = persistence;
      if (
        !activePersistence ||
        !entry ||
        entry.draft ||
        entry.conflict ||
        !entry.dirty ||
        !canPersistNotebookToServer({ draft: false, myPermission: entry.notebook.myPermission })
      ) {
        return false;
      }

      const generation = entry.editGeneration;
      const baseRevision = entry.notebook.revision;
      const snapshot = entry.notebook;
      useNotebookStore.setState((state) => {
        const current = state.open[id];
        if (!current || current.editGeneration !== generation) return state;
        return { open: { ...state.open, [id]: { ...current, saving: true } } };
      });

      try {
        const saved = await activePersistence.update(id, snapshot);
        if (coordinator.cancelled) {
          if (coordinator.rebaseOnCompletion) rebaseReopenedNotebook(id, baseRevision, saved);
          return false;
        }
        const current = useNotebookStore.getState().open[id];
        if (
          current &&
          !current.draft &&
          current.notebook.revision === baseRevision &&
          current.editGeneration >= generation
        ) {
          useNotebookStore.getState().markSaved(id, saved, generation);
          settleSaveWaiters(coordinator, generation, saved);
        } else {
          // 閉じ直しや外部置換後に届いた旧応答は現在の編集状態へ適用しない。
          settleSaveWaiters(coordinator, generation, null);
        }
      } catch (error) {
        // 失敗しても dirty のままにしておくことで、次の編集で再スケジュール
        // される（＝リトライの仕組みを別途持たず、自然に再試行される）。
        // 失敗自体のユーザー通知は呼び出し元（保存ボタン等）が toast で表示する。
        if (coordinator.cancelled) return false;
        const current = useNotebookStore.getState().open[id];
        const sameBase = current?.notebook.revision === baseRevision;
        const conflict = error instanceof ApiClientError && error.status === 409;
        const hasNewerGeneration =
          sameBase && current !== undefined && current.editGeneration > generation;
        if (current && sameBase && conflict) {
          clearAutosave(id);
          useNotebookStore.setState((state) => ({
            open: {
              ...state.open,
              [id]: { ...current, saving: false, conflict: true },
            },
          }));
          for (const waiter of coordinator.waiters) waiter.resolve(null);
          coordinator.waiters = [];
          return false;
        }
        if (!hasNewerGeneration) {
          if (current && sameBase) {
            useNotebookStore.setState((state) => ({
              open: { ...state.open, [id]: { ...current, saving: false } },
            }));
          }
          settleSaveWaiters(coordinator, generation, null);
          return false;
        }
        // 古い世代の一時失敗は最新世代へ反映せず、最新snapshotを続けて試す。
      }

      const latest = useNotebookStore.getState().open[id];
      if (!latest || latest.conflict || !latest.dirty || latest.editGeneration <= generation) {
        return false;
      }
      clearAutosave(id);
      return true;
    });
    if (!shouldContinue) break;
  }

  coordinator.running = false;
  for (const waiter of coordinator.waiters) waiter.resolve(null);
  coordinator.waiters = [];
  if (saveCoordinators.get(id) === coordinator) saveCoordinators.delete(id);
}

// ---- 命令的な保存ヘルパー（Ctrl+S や保存ボタンから使う）----------------
// ストアの action ではなくモジュール関数として提供しているのは、Ctrl+S や
// 保存ボタンのハンドラから React の外側（イベントハンドラ）で直接呼びたい
// ためで、useNotebookStore.getState() を使って imperative にストアへアクセスする。

/**
 * まだ一度もサーバーに保存されていない draft notebook を、指定した名前で
 * 初めて永続化（POST 相当）し、保存済み notebook として再登録する。
 * persistence が配線されていない場合、または永続化に失敗した場合は null を返す。
 */
export async function persistNewNotebook(id: string, name: string): Promise<Notebook | null> {
  if (!persistence) return null;
  const store = useNotebookStore.getState();
  const entry = store.open[id];
  if (!entry) return null;
  store.setSaving(id, true);
  const body = { ...entry.notebook, name: name.trim() || 'Untitled notebook' };
  try {
    const saved = await persistence.create(body);
    store.markSaved(id, saved, entry.editGeneration);
    return saved;
  } catch {
    store.setSaving(id, false);
    return null;
  }
}

/**
 * 既に保存済みの notebook を、オートセーブのデバウンスを待たずに今すぐ
 * 永続化（PUT 相当）する。Ctrl/Cmd+S などの明示的な保存操作から呼ばれる。
 * persistence が配線されていない場合、または永続化に失敗した場合は null を返す。
 */
export async function persistSavedNotebook(id: string): Promise<Notebook | null> {
  const store = useNotebookStore.getState();
  const entry = store.open[id];
  if (!entry || entry.draft || entry.conflict) return null;
  if (!canPersistNotebookToServer({ draft: false, myPermission: entry.notebook.myPermission })) {
    return null;
  }
  // 明示的な保存が発火するので、待機中のデバウンス timer は不要になる。
  clearAutosave(id);
  return requestSavedNotebookSave(id);
}

// ---- selector hook 群 ---------------------------------------------------------
// コンポーネントがストアを読み取るための入口。生の useNotebookStore を
// 各所で直接 select するのではなく、ここに集約しておくことで再レンダリングの
// 最適化ポイントを一箇所にまとめている。

/** 現在アクティブな開いている notebook。何も開かれていなければ undefined。 */
export function useActiveNotebook(): OpenNotebook | undefined {
  return useNotebookStore((s) => (s.activeId ? s.open[s.activeId] : undefined));
}

/**
 * TopBar 用のタブ記述子（id、name、dirty、ブラウザー内永続化エラー）を、
 * タブの表示順で返す。
 * `openIds` と `open` という参照が安定した state を `useShallow` で購読し、
 * 表示用オブジェクトはレンダー内で毎回組み立てる。selector内で新しい表示用
 * オブジェクトを返すと`useShallow`の要素比較を無効にしてループするためである。
 */
export function useNotebookTabs(): {
  id: string;
  name: string;
  dirty: boolean;
  conflict: boolean;
  localPersistenceError: boolean;
}[] {
  const openIds = useNotebookStore(useShallow((s) => s.openIds));
  const open = useNotebookStore((s) => s.open);
  return openIds
    .filter((id) => open[id])
    .map((id) => {
      const e = open[id]!;
      return {
        id,
        name: e.notebook.name,
        dirty: e.dirty,
        conflict: e.conflict,
        localPersistenceError: e.localPersistenceError,
      };
    });
}

// Notebook store. One zustand
// store owns every *open* notebook (the TopBar tabs), the active id, and each
// open notebook's dirty / draft / saving state. Cell CRUD, reordering, variable
// values and the title/description all flow through here.
//
// Persistence policy:
//   - A *saved* notebook (has a server id, `draft === false`) is autosaved with a
//     2s debounce via PUT, and on an explicit Ctrl/Cmd+S.
//   - A *draft* notebook (never persisted, `draft === true`) is kept in
//     localStorage so a reload restores it; the first explicit save POSTs it and
//     flips it to a saved notebook.
//   - The set of open tabs + the active id are mirrored to localStorage so a
//     reload reopens the same workspace.
//
// Network calls are injected (`__setPersistence`) so the store is unit-testable
// with fake timers and no fetch. Components read via the selector hooks at the
// end; cell-execution lifecycle (clear on delete) is the caller's job — the
// store stays free of the execution layer to avoid a cycle.
//
// ==== ファイルの責務（日本語） ================================================
// notebook 機能レイヤーの中核となる zustand ストア。
//   - 「開いている notebook 群」（TopBar のタブ）・アクティブな notebook id・
//     各 notebook の dirty（未保存変更あり）/ draft（未保存 notebook）/ saving
//     （保存 API 実行中）状態を一元管理する。
//   - セルの追加、削除、並べ替え、ソース編集、notebook のタイトル/説明/実行
//     context（catalog/schema）の変更、変数値の更新は、すべてこのストアの
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
import type {
  Cell,
  CellKind,
  CellResultMeta,
  ChartConfig,
  Notebook,
  NotebookContext,
  Variable,
} from '@hubble/contracts';
import { uid } from '../utils/id';
import { detectVariables, reconcileVariables } from './variables';
import { readRecentContexts } from './recentContexts';
import { canPersistNotebookToServer } from '../utils/documentShare';

// ---- Persistence injection --------------------------------------------------

/**
 * notebook の作成（POST 相当）と更新（PUT 相当）という、ストアが必要とする
 * ネットワーク操作だけを切り出した interface。実装は起動時に注入され、テスト
 * では fetch を使わないスタブに差し替えられる。
 */
/** The network surface the store needs; injected so tests can stub it. */
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
/** Wire the real API (or a stub in tests). Call once at app start. */
export function __setPersistence(p: NotebookPersistence | null): void {
  persistence = p;
}

/** オートセーブのデバウンス時間（2 秒でデバウンス）。 */
/** Autosave debounce window (debounce 2s). */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

// ---- localStorage keys ------------------------------------------------------

// ワークスペース（開いているタブ id 一覧 + アクティブ id）を保存するキー。
const WORKSPACE_KEY = 'hubble-workspace'; // open tab ids + active id
// draft notebook 1 件ごとのスナップショットを保存するキーの接頭辞（末尾に id が付く）。
const DRAFT_PREFIX = 'hubble-draft:'; // per-draft notebook snapshot

// ---- Open-notebook record ---------------------------------------------------

/**
 * 「開いている」notebook 1 件分のレコード。notebook 本体（サーバー/契約層の
 * データ形）に、エディタ上の編集状態（dirty/draft/saving）を添えたもの。
 */
/** An open notebook plus its editing state. */
export interface OpenNotebook {
  notebook: Notebook;
  // 直前の永続化以降に未保存の変更があるかどうか。
  /** Has unsaved changes since the last successful persist. */
  dirty: boolean;
  // true の間はまだ一度もサーバーに保存されていない draft。保存後は false になり、
  // 以降は実 id を持って PUT オートセーブの対象になる。
  /** True until first persisted to the server (then it has a real id + PUTs). */
  draft: boolean;
  // 保存 API（POST/PUT）が実行中かどうか（保存ボタンのスピナー等に使う）。
  /** A save (POST/PUT) is in flight. */
  saving: boolean;
}

// ストアが公開する state と action の全体。
interface NotebookStoreState {
  // id をキーにした「開いている notebook」の集合。並び順は持たない
  // （タブの表示順は openIds が担う）。
  /** Open notebooks keyed by id, in no particular order (order is `openIds`). */
  open: Record<string, OpenNotebook>;
  // タブの表示順（左→右）。
  /** Tab order (left→right). */
  openIds: string[];
  // 現在アクティブな（前面に表示されている）notebook の id。開いている
  // notebook がなければ null。
  activeId: string | null;

  // Lifecycle
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
  setActive: (id: string) => void;
  // 空の SQL セル 1 つを持つ notebook を新規 draft として開き、その id を返す。
  createBlankNotebook: () => string;

  // Notebook-level edits
  // notebook のタイトルを変更する（空文字は "Untitled notebook" にフォールバック）。
  renameNotebook: (id: string, name: string) => void;
  // notebook の説明文を変更する。
  setDescription: (id: string, description: string) => void;
  // notebook の実行 context（catalog/schema）を変更する。
  setContext: (id: string, context: NotebookContext) => void;

  // Cell edits
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
  /** Write the last-execution summary into a cell (`resultMeta`). */
  setCellResultMeta: (cellId: string, meta: CellResultMeta) => void;
  // セルのチャート設定を更新する（ユーザーのチャート操作のたびに呼ばれ、
  // notebook 本体と一緒にサーバーへ永続化される）。
  setCellChart: (cellId: string, chart: ChartConfig) => void;

  // Variables
  // 変数の入力値のみを更新する（SQL 自体は変わらないため変数の再検出は行わない）。
  setVariableValue: (id: string, name: string, value: string) => void;

  // Persistence
  // 保存完了後の後処理: dirty/saving をリセットし、POST で id が変わった場合は
  // タブの key を新しい id に付け替える。
  markSaved: (id: string, persisted: Notebook) => void;
  // saving フラグだけを更新する（保存開始/失敗時のマーキングに使う）。
  setSaving: (id: string, saving: boolean) => void;
}

// ---- Pure helpers (exported for tests) --------------------------------------
// ここから下は副作用のない純粋関数群。ストアの action から使われるだけでなく、
// テストからも直接呼べるよう export されている。

/**
 * 空の SQL セルを 1 つだけ持つ、まっさらな notebook を生成する
 * （初回起動時に使われる形）。id と timestamp はここで払い出す。
 */
/** A fresh blank notebook with one empty SQL cell. */
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
  };
}

// 指定した種類（sql/markdown）の空セルを 1 つ生成する内部ヘルパー。
/** A new empty cell of the given kind with a stable id. */
function newCell(kind: CellKind): Cell {
  return { id: uid('cell'), kind, source: '' };
}

/**
 * notebook の SQL セル群から `${name}` プレースホルダーを検出し直し、
 * `notebook.variables` を再計算する。ユーザーが既に入力済みの値は
 * `reconcileVariables` 側で名前が一致するものを引き継ぐため失われない。
 * セルのソースを編集するたびに呼ばれる。
 */
/** Recompute `notebook.variables` from its SQL cells, preserving typed values. */
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
/** Move an array element from `from` to `to`, returning a new array. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = arr.slice();
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

// ---- Draft / workspace persistence (localStorage) ---------------------------
// リロード後の復元用に、ワークスペース（開いているタブ構成）と draft notebook
// の中身を localStorage に書き出す/読み戻すための一群の関数。

// localStorage に保存するワークスペースのスナップショット形。
interface WorkspaceSnapshot {
  openIds: string[];
  activeId: string | null;
  /** Which of the open ids are drafts (so we know to load from DRAFT_PREFIX). */
  draftIds: string[];
}

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
function writeWorkspace(state: NotebookStoreState): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  const draftIds = state.openIds.filter((id) => state.open[id]?.draft);
  const snapshot: WorkspaceSnapshot = {
    openIds: state.openIds,
    activeId: state.activeId,
    draftIds,
  };
  try {
    ls.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / serialization — non-fatal */
  }
}

// draft notebook 1 件の中身をまるごと localStorage に書き出す（編集のたびに
// 呼ばれ、これがそのまま「draft のオートセーブ」の実体になる）。
function writeDraft(notebook: Notebook): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(`${DRAFT_PREFIX}${notebook.id}`, JSON.stringify(notebook));
  } catch {
    /* non-fatal */
  }
}

// draft のスナップショットを削除する（タブを閉じた時、保存が完了して正式な
// notebook になった時に呼ばれる）。
function removeDraft(id: string): void {
  safeLocalStorage()?.removeItem(`${DRAFT_PREFIX}${id}`);
}

// draft notebook 1 件を localStorage から読み戻す。壊れていれば null。
function readDraft(id: string): Notebook | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  const raw = ls.getItem(`${DRAFT_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Notebook;
  } catch {
    return null;
  }
}

/**
 * 永続化済みのワークスペーススナップショット（開いていたタブ id 群 +
 * アクティブ id）を読み出す。何もなければ null。アプリ起動時の復元に使う。
 */
/** The persisted workspace snapshot (open tab ids + active), or null. */
export function readWorkspaceSnapshot(): WorkspaceSnapshot | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  const raw = ls.getItem(WORKSPACE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkspaceSnapshot;
  } catch {
    return null;
  }
}

/**
 * ワークスペーススナップショットに記録された draft id のうち、
 * 復元可能なもの（localStorage に実体が残っているもの）をすべて読み出す。
 */
/** Read all restorable draft notebooks named in the workspace snapshot. */
export function readDrafts(): Notebook[] {
  const snapshot = readWorkspaceSnapshot();
  if (!snapshot) return [];
  return snapshot.draftIds.map((id) => readDraft(id)).filter((nb): nb is Notebook => nb !== null);
}

// ---- Autosave scheduling ----------------------------------------------------

// Per-notebook debounce timers live outside the reactive store so scheduling a
// save never triggers a render.
// notebook id → デバウンス用 timer のマップ。zustand の state に入れず
// モジュールスコープに置くことで、timer のスケジューリング自体が再レンダーの
// トリガーにならないようにしている。
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 保留中のオートセーブ timer を取り消す（保存が完了した時、閉じられた時、
// 新しい編集で timer をリセットする時に呼ばれる）。
function clearAutosave(id: string): void {
  const t = autosaveTimers.get(id);
  if (t) {
    clearTimeout(t);
    autosaveTimers.delete(id);
  }
}

// ---- Store ------------------------------------------------------------------

export const useNotebookStore = create<NotebookStoreState>((set, get) => {
  // mutate / afterChange / scheduleAutosave / saveNow は、ほぼすべての
  // notebook 編集 action から呼ばれる共通の下請け関数群。
  // 「notebook を書き換える → 変数を再計算する → dirty にする →
  //  永続化をトリガーする」という一連の流れを 1 箇所にまとめている。

  /** Replace one open notebook's `notebook`, recompute variables, mark dirty. */
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
    set((s) => ({ open: { ...s.open, [id]: { ...entry, notebook: next, dirty: true } } }));
    afterChange(id);
  };

  /** After any change: persist the draft locally and (if saved) schedule a PUT. */
  const afterChange = (id: string): void => {
    const entry = get().open[id];
    if (!entry) return;
    if (entry.draft) {
      // draft はサーバーに保存先がないので localStorage への書き出しだけ行う。
      writeDraft(entry.notebook);
    } else if (
      canPersistNotebookToServer({ draft: false, myPermission: entry.notebook.myPermission })
    ) {
      // 保存済み notebook はデバウンスして PUT する（view 共有はスキップ）。
      scheduleAutosave(id);
    }
  };

  /** Debounced PUT for a saved notebook (2s debounce). */
  const scheduleAutosave = (id: string): void => {
    // 直前の timer を破棄してから新しく張り直す = 連続編集中は PUT が
    // 発火しない（最後の編集から 2 秒静止して初めて保存される）。
    clearAutosave(id);
    const timer = setTimeout(() => {
      autosaveTimers.delete(id);
      void saveNow(id);
    }, AUTOSAVE_DEBOUNCE_MS);
    autosaveTimers.set(id, timer);
  };

  /** Persist immediately via PUT (saved notebooks only). */
  const saveNow = async (id: string): Promise<void> => {
    const entry = get().open[id];
    if (!entry || entry.draft || !persistence) return;
    if (!canPersistNotebookToServer({ draft: false, myPermission: entry.notebook.myPermission })) {
      return;
    }
    if (!entry.dirty) return;
    set((s) => ({ open: { ...s.open, [id]: { ...entry, saving: true } } }));
    try {
      const saved = await persistence.update(id, entry.notebook);
      get().markSaved(id, saved);
    } catch {
      // Keep dirty; a later edit reschedules. Surface via toast at the call site.
      // 失敗しても dirty のままにしておくことで、次の編集で再スケジュール
      // される（＝リトライの仕組みを別途持たず、自然に再試行される）。
      const cur = get().open[id];
      if (cur) set((s) => ({ open: { ...s.open, [id]: { ...cur, saving: false } } }));
    }
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
      set((s) => {
        const open = {
          ...s.open,
          [notebook.id]: existing
            ? { ...existing }
            : { notebook, dirty: false, draft, saving: false },
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
      writeWorkspace(get());
    },

    replaceNotebook: (notebook) => {
      const existing = get().open[notebook.id];
      if (!existing) return;
      // 保留中のオートセーブがあれば取り消す (古い内容を PUT しないため)。
      clearAutosave(notebook.id);
      set((s) => ({
        open: {
          ...s.open,
          [notebook.id]: { notebook, dirty: false, draft: false, saving: false },
        },
      }));
    },

    closeNotebook: (id) => {
      // 閉じるタブに保留中のオートセーブがあれば取り消す。
      clearAutosave(id);
      const entry = get().open[id];
      // draft なら localStorage 上の下書きも一緒に消す（復元されないように）。
      if (entry?.draft) removeDraft(id);
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
      writeWorkspace(get());
    },

    setActive: (id) => {
      // 開かれていない id は無視する。
      if (!get().open[id]) return;
      set({ activeId: id });
      writeWorkspace(get());
    },

    createBlankNotebook: () => {
      // Seed the new notebook's context from the active notebook, falling back to
      // the most-recently-used context.
      // アクティブな notebook が catalog/schema を持っていればそれを引き継ぎ、
      // 持っていなければ直近使用した context（recentContexts）の先頭を使う。
      const active = get().activeId ? get().open[get().activeId!]?.notebook.context : undefined;
      const ctx =
        active && (active.catalog || active.schema) ? active : (readRecentContexts()[0] ?? {});
      const nb = blankNotebook(ctx);
      get().openNotebook(nb, { draft: true, activate: true });
      writeDraft(nb);
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
      // Locate the open notebook that owns this cell (cellId is globally unique).
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
      // resultMeta is a derived summary, not user content — don't bump updatedAt
      // or recompute variables. It still rides along on the next persist.
      // （resultMeta は実行結果から派生する情報であり、ユーザーが入力した
      // コンテンツではないため updatedAt や変数再計算の対象にはしない。
      // ただし dirty にはするので、次回の保存には一緒に乗る。）
      const next = { ...entry.notebook, cells };
      set((s) => ({ open: { ...s.open, [ownerId]: { ...entry, notebook: next, dirty: true } } }));
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
      // A value change doesn't alter the SQL, so skip the variable recompute and
      // update only the matching variable's value.
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
      set((s) => ({ open: { ...s.open, [id]: { ...entry, notebook: next, dirty: true } } }));
      afterChange(id);
    },

    markSaved: (id, persisted) => {
      // 保存が完了したので、保留中のオートセーブ timer はもう不要。
      clearAutosave(id);
      const entry = get().open[id];
      if (!entry) return;
      const wasDraft = entry.draft;
      // The server may have assigned a new id (POST). Re-key under it.
      // draft の初回保存（POST）ではサーバーが新しい id を発行するため、
      // open/openIds/activeId すべてでキーを古い id → 新しい id に付け替える。
      const newKey = persisted.id;
      set((s) => {
        const open = { ...s.open };
        delete open[id];
        open[newKey] = { notebook: persisted, dirty: false, draft: false, saving: false };
        const openIds = s.openIds.map((x) => (x === id ? newKey : x));
        const activeId = s.activeId === id ? newKey : s.activeId;
        return { open, openIds, activeId };
      });
      // draft から昇格したので、もう localStorage の下書きは不要。
      if (wasDraft) removeDraft(id);
      writeWorkspace(get());
    },

    setSaving: (id, saving) => {
      const entry = get().open[id];
      if (!entry) return;
      set((s) => ({ open: { ...s.open, [id]: { ...entry, saving } } }));
    },
  };
});

// ---- Imperative save helpers (used by Ctrl+S / Save buttons) ----------------
// ストアの action ではなくモジュール関数として提供しているのは、Ctrl+S や
// 保存ボタンのハンドラから React の外側（イベントハンドラ）で直接呼びたい
// ためで、useNotebookStore.getState() を使って imperative にストアへアクセスする。

/**
 * まだ一度もサーバーに保存されていない draft notebook を、指定した名前で
 * 初めて永続化（POST 相当）し、保存済み notebook として再登録する。
 * persistence が配線されていなければ null を返す。
 */
/**
 * Persist a draft notebook for the first time (POST) under a chosen name, then
 * re-key it as a saved notebook. Returns the persisted notebook, or null when
 * persistence isn't wired.
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
    store.markSaved(id, saved);
    return saved;
  } catch {
    store.setSaving(id, false);
    return null;
  }
}

/**
 * 既に保存済みの notebook を、オートセーブのデバウンスを待たずに今すぐ
 * 永続化（PUT 相当）する。Ctrl/Cmd+S などの明示的な保存操作から呼ばれる。
 */
/**
 * Persist an already-saved notebook now (PUT), bypassing the debounce. Returns
 * the persisted notebook, or null on failure / when not wired.
 */
export async function persistSavedNotebook(id: string): Promise<Notebook | null> {
  if (!persistence) return null;
  const store = useNotebookStore.getState();
  const entry = store.open[id];
  if (!entry || entry.draft) return null;
  if (!canPersistNotebookToServer({ draft: false, myPermission: entry.notebook.myPermission })) {
    return null;
  }
  // 明示的な保存が発火するので、待機中のデバウンス timer は不要になる。
  clearAutosave(id);
  store.setSaving(id, true);
  try {
    const saved = await persistence.update(id, entry.notebook);
    store.markSaved(id, saved);
    return saved;
  } catch {
    store.setSaving(id, false);
    return null;
  }
}

// ---- Selector hooks ---------------------------------------------------------
// コンポーネントがストアを読み取るための入口。生の useNotebookStore を
// 各所で直接 select するのではなく、ここに集約しておくことで再レンダリングの
// 最適化ポイントを一箇所にまとめている。

/** 現在アクティブな開いている notebook。何も開かれていなければ undefined。 */
/** The currently active open notebook, or undefined. */
export function useActiveNotebook(): OpenNotebook | undefined {
  return useNotebookStore((s) => (s.activeId ? s.open[s.activeId] : undefined));
}

/**
 * TopBar 用のタブ記述子（id / name / dirty）を、タブの表示順で返す。
 * `openIds` と `open` という参照が安定した state を `useShallow` で購読し、
 * 表示用オブジェクトはレンダー内で毎回組み立てる。
 */
/**
 * Tab descriptors for the TopBar (id, name, dirty), in tab order. We subscribe
 * to the stable `openIds` + `open` references with `useShallow` and derive the
 * descriptor objects in render — returning fresh objects from the selector would
 * defeat `useShallow`'s element-wise comparison and loop.
 */
export function useNotebookTabs(): { id: string; name: string; dirty: boolean }[] {
  const openIds = useNotebookStore(useShallow((s) => s.openIds));
  const open = useNotebookStore((s) => s.open);
  return openIds
    .filter((id) => open[id])
    .map((id) => {
      const e = open[id]!;
      return { id, name: e.notebook.name, dirty: e.dirty };
    });
}

/**
 * UI 全体の見た目やレイアウトに関する状態を管理する zustand ストアの定義ファイル。
 * テーマ（ライト/ダーク）、サイドバーの表示状態や幅、コマンドパレットの
 * 開閉、保存ダイアログの要求など、画面表示に関する状態を一箇所に集約する。
 * ノートブックの内容やクエリ実行結果、メタデータなど「データ」寄りの状態は
 * 別のストアで管理される（本ストアは純粋にプレゼンテーション層の状態のみ扱う）。
 */
// zustand: 軽量な状態管理ライブラリ。create でストア（フックとして使える状態コンテナ）を生成する。
import { create } from 'zustand';
// persist ミドルウェア: ストアの状態の一部を localStorage 等に永続化し、
// ページ再読み込み後も復元できるようにする。
import { persist } from 'zustand/middleware';
import { principalStorageKey } from '../storage/principalStorage';
import { requestDocumentNavigation } from '../navigation/documentNavigation';

/**
 * UI store: theme + shell layout state only. Presentation
 * concerns live here; notebook/execution/metadata stores arrive in later phases.
 * Theme is persisted; transient flags (palette open) are not.
 *
 * UI ストア: テーマとシェルのレイアウト状態のみを扱う。
 * プレゼンテーション（見た目）に関する関心事はここに集約し、
 * ノートブックの内容、クエリ実行、メタデータ関連のストアは
 * 後続のフェーズで別途追加される想定。
 * テーマは localStorage に永続化されるが、コマンドパレットの開閉状態のような
 * 一時的なフラグは永続化されない（アプリ再起動時にリセットされる）。
 */

/** テーマの種類。ライトモードとダークモードの2種類のみをサポートする。 */
export type ThemeMode = 'light' | 'dark';

/** Sidebar sections (Query Scheduling adds 'schedules'). */
/**
 * サイドバーに表示されるセクション（タブ）の種類。
 * 'data'（データカタログ）、'notebooks'（ノートブック一覧）、
 * 'saved'（保存済みクエリ）、'history'（実行履歴）、
 * 'schedules'（クエリスケジュール、後から追加された機能）、
 * 'alerts'（閾値監視アラート）、
 * 'workflows'（クエリワークフロー）の8種類。
 */
export type SidebarTab =
  | 'data'
  | 'notebooks'
  | 'saved'
  | 'history'
  | 'schedules'
  | 'alerts'
  | 'dashboards'
  | 'workflows'
  | 'operations';

/**
 * メインエリアに表示するワークフロービューの状態。
 * null はノートブック表示 (通常状態)、`{ kind: 'workflow' }` は既存ワークフローの
 * 編集/実行ビュー、`{ kind: 'new-workflow' }` は新規作成ビューを表す。
 * 一時的な画面状態のため永続化しない。
 */
export type WorkflowViewState = { kind: 'workflow'; id: string } | { kind: 'new-workflow' } | null;

/**
 * メインエリアに表示するダッシュボードビューの状態。
 * null はノートブック表示 (通常状態)、`{ kind: 'dashboard' }` は既存ダッシュボードの
 * 表示/編集ビュー、`{ kind: 'new-dashboard' }` は新規作成ビューを表す。
 * 一時的な画面状態のため永続化しない。
 */
export type DashboardViewState =
  | { kind: 'dashboard'; id: string }
  | { kind: 'new-dashboard' }
  | null;

/** AI パネルの最小幅（ピクセル）。 */
export const AI_PANEL_MIN_WIDTH = 280;
/** AI パネルの最大幅（ピクセル）。 */
export const AI_PANEL_MAX_WIDTH = 640;
/** AI パネルの初期表示幅（ピクセル）。 */
export const AI_PANEL_DEFAULT_WIDTH = 360;

/** サイドバーの最小幅（ピクセル）。これより狭くはドラッグでリサイズできない。 */
export const SIDEBAR_MIN_WIDTH = 200;
/** サイドバーの最大幅（ピクセル）。これより広くはドラッグでリサイズできない。 */
export const SIDEBAR_MAX_WIDTH = 520;
/** サイドバーの初期表示幅（ピクセル）。 */
export const SIDEBAR_DEFAULT_WIDTH = 288;

// 指定したテーマモードを実際の DOM に反映するヘルパー関数。
// <html> 要素に data-theme 属性をセットすることで、CSS 側のテーマ切り替えセレクタ
// （例: [data-theme="dark"]）と連動させる。SSR 等で document が存在しない
// 環境では何もしない。
function applyTheme(mode: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

// サイドバー幅を許容範囲（SIDEBAR_MIN_WIDTH 〜 SIDEBAR_MAX_WIDTH）に収める。
// ドラッグ操作などで範囲外の値が渡された場合でも、この関数を通すことで
// 常に妥当な幅に丸め込まれる。整数に丸めてから min/max でクランプする。
function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

// AI パネル幅を許容範囲（AI_PANEL_MIN_WIDTH 〜 AI_PANEL_MAX_WIDTH）に収める。
function clampAiPanelWidth(width: number): number {
  return Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(width)));
}

/**
 * A transient request to open a notebook save dialog. `mode: 'save'` is the
 * first save of a draft; `mode: 'saveAs'` always prompts. A monotonically
 * increasing `nonce` lets AppShell react even when the same mode is requested
 * twice in a row.
 *
 * ノートブックの保存ダイアログを開くための一時的な要求を表す型。
 * `mode: 'save'` は下書きの初回保存（保存先が未確定の場合はダイアログ表示）、
 * `mode: 'saveAs'` は常に保存先を尋ねるダイアログを表示する「名前を付けて保存」。
 * `nonce` は単調増加する値で、同じ mode が連続して要求された場合でも
 * （オブジェクトの参照や値が変化しないと React の変更検知が働かないため）
 * AppShell 側が確実にその要求を検知して反応できるようにする。
 */
export interface SaveRequest {
  mode: 'save' | 'saveAs';
  nonce: number;
}

// UI ストアが保持する状態と、それを操作するためのアクション（関数）の型定義。
// zustand のストアはこの単一のインターフェースに沿った1つのオブジェクトとして生成される。
interface UiState {
  /** 現在のテーマ（'light' | 'dark'）。localStorage に永続化される。 */
  theme: ThemeMode;
  /** 現在選択されているサイドバータブ。永続化される。 */
  sidebarTab: SidebarTab;
  /** サイドバーの現在の幅（ピクセル）。永続化される。 */
  sidebarWidth: number;
  /** サイドバーが折りたたまれているかどうか。永続化される。 */
  sidebarCollapsed: boolean;
  /** コマンドパレットが開いているかどうか。一時的な状態のため永続化されない。 */
  paletteOpen: boolean;
  /** 保留中の保存ダイアログ要求。要求がなければ null。 */
  saveRequest: SaveRequest | null;
  /** Bumped to request the sidebar focus its search field (command palette). */
  // コマンドパレットの「Go to」系コマンドなどからサイドバーの検索欄への
  // フォーカスを要求するために増加させるカウンター（nonce）。
  sidebarFocusNonce: number;
  /** "Keyboard shortcuts" help modal. */
  // キーボードショートカット一覧のヘルプモーダルが開いているかどうか。
  shortcutsHelpOpen: boolean;
  /** Presentation mode toggle (stretch: SQL カード表示). */
  // プレゼンテーションモード（SQL をカード形式で見せるような表示切り替え）の有効/無効。
  presentationMode: boolean;
  /**
   * The shell's current catalog.schema + default LIMIT, mirrored here by AppShell
   * so global shortcuts (run-active-cell) can read them without prop threading.
   */
  // AppShell が現在選択しているカタログとスキーマ情報のコピー。
  // グローバルなキーボードショートカット（アクティブセルの実行など）が
  // props のバケツリレーをせずにこれらの値を参照できるようにするためのミラー。
  shellContext: { catalog?: string; schema?: string; datasourceId?: string };
  // シェル側で設定されているデフォルトの LIMIT 件数のミラー。
  shellDefaultLimit: number;
  /** メインエリアに表示するワークフロービュー。null ならノートブック表示。 */
  workflowView: WorkflowViewState;
  /** メインエリアに表示するダッシュボードビュー。null ならノートブック表示。 */
  dashboardView: DashboardViewState;
  /** AI アシスタントパネルが開いているかどうか。永続化される。 */
  aiPanelOpen: boolean;
  /** AI アシスタントパネルの幅（ピクセル）。永続化される。 */
  aiPanelWidth: number;

  /** テーマを指定した値に設定し、DOM にも即座に反映する。 */
  setTheme: (mode: ThemeMode) => void;
  /** 現在のテーマをライト/ダークで反転させる。 */
  toggleTheme: () => void;
  /** アクティブなサイドバータブを切り替え、同時に折りたたみを解除する。 */
  setSidebarTab: (tab: SidebarTab) => void;
  /** サイドバー幅を設定する（許容範囲にクランプしてから保存する）。 */
  setSidebarWidth: (width: number) => void;
  /** サイドバーの折りたたみ状態を反転させる。 */
  toggleSidebar: () => void;
  /** コマンドパレットの開閉状態を明示的に設定する。 */
  setPaletteOpen: (open: boolean) => void;
  /** コマンドパレットの開閉状態を反転させる。 */
  togglePalette: () => void;
  /** 保存ダイアログの表示を要求する。nonce をインクリメントして再要求を検知可能にする。 */
  requestSave: (mode: SaveRequest['mode']) => void;
  /** 保留中の保存ダイアログ要求をクリアする（ダイアログを閉じた後などに呼ぶ）。 */
  clearSaveRequest: () => void;
  /** Switch to a sidebar tab, expand it, and focus its search (Go to … commands). */
  // 指定したサイドバータブへ切り替え、折りたたみを解除したうえで、
  // そのタブの検索欄にフォーカスを当てるよう要求する（「Go to …」系コマンド用）。
  gotoSidebar: (tab: SidebarTab) => void;
  /** ショートカットヘルプモーダルの開閉状態を設定する。 */
  setShortcutsHelpOpen: (open: boolean) => void;
  /** プレゼンテーションモードの有効/無効を反転させる。 */
  togglePresentation: () => void;
  /** AppShell から現在のカタログ/スキーマとデフォルト LIMIT のミラーを更新する。 */
  setShellRuntime: (
    context: { catalog?: string; schema?: string; datasourceId?: string },
    defaultLimit: number,
  ) => void;
  /** 既存ワークフローをメインエリアで開く。 */
  openWorkflow: (id: string) => void;
  /** 新規ワークフロー作成ビューをメインエリアで開く。 */
  openNewWorkflow: () => void;
  /** ワークフロービューを閉じてノートブック表示へ戻る。 */
  closeWorkflow: () => void;
  /** 既存ダッシュボードをメインエリアで開く。 */
  openDashboard: (id: string) => void;
  /** 新規ダッシュボード作成ビューをメインエリアで開く。 */
  openNewDashboard: () => void;
  /** ダッシュボードビューを閉じてノートブック表示へ戻る。 */
  closeDashboard: () => void;
  /** AI パネルの開閉状態を反転させる。 */
  toggleAiPanel: () => void;
  /** AI パネルの幅を設定する（許容範囲にクランプしてから保存する）。 */
  setAiPanelWidth: (width: number) => void;
}

/**
 * UI 状態を管理する zustand ストア本体。
 * `persist` ミドルウェアで包むことで、一部の状態（テーマやサイドバーの
 * レイアウト設定など）が localStorage の `hubble-ui` キーに自動的に
 * 保存され、復元される。コンポーネントからは `useUiStore()` フックとして
 * 呼び出すことで、状態の読み取りとアクションの呼び出しの両方ができる。
 */
export const useUiStore = create<UiState>()(
  persist(
    // set: 部分的な状態更新を行う関数。get: 現在の状態を読み取る関数。
    (set, get) => ({
      // --- 状態の初期値 ---
      theme: 'light',
      sidebarTab: 'data',
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      paletteOpen: false,
      saveRequest: null,
      sidebarFocusNonce: 0,
      shortcutsHelpOpen: false,
      presentationMode: false,
      shellContext: {},
      shellDefaultLimit: 5000,
      workflowView: null,
      dashboardView: null,
      aiPanelOpen: false,
      aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,

      // --- 各アクション（状態を更新する関数）の実装 ---

      // テーマを明示的に指定の値へ変更する。DOM への反映（data-theme 属性）と
      // ストア状態の更新の両方を行う。
      setTheme: (mode) => {
        applyTheme(mode);
        set({ theme: mode });
      },
      // 現在のテーマを見て、逆のテーマに切り替える（dark -> light, light -> dark）。
      toggleTheme: () => {
        const next: ThemeMode = get().theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        set({ theme: next });
      },
      // サイドバータブを切り替える際、折りたたまれていた場合は自動的に展開する
      // （タブを選んだのに中身が見えない、という状態を避けるため）。
      setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarCollapsed: false }),
      // サイドバー幅を設定する。事前に clampWidth で許容範囲に丸める。
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
      // サイドバーの折りたたみ状態をトグルする。直前の状態を受け取って反転させる。
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      // コマンドパレットの開閉を明示的な真偽値で設定する。
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      // コマンドパレットの開閉をトグルする。
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      // 保存ダイアログの表示を要求する。既存の saveRequest があればその nonce を
      // +1 し、なければ 0 から開始して +1 することで常に一意な値にする。
      // これにより同じ mode の要求が連続しても React 側で変更として検知される。
      requestSave: (mode) =>
        set((s) => ({ saveRequest: { mode, nonce: (s.saveRequest?.nonce ?? 0) + 1 } })),
      // 保存ダイアログ要求をクリアする（ダイアログが閉じられた後などに呼ばれる）。
      clearSaveRequest: () => set({ saveRequest: null }),
      // 「Go to …」系のコマンドから呼ばれる: 指定タブへ切り替え、折りたたみを
      // 解除し、さらに sidebarFocusNonce をインクリメントすることで
      // サイドバー側の検索欄に自動フォーカスさせるためのシグナルを送る。
      gotoSidebar: (tab) =>
        set((s) => ({
          sidebarTab: tab,
          sidebarCollapsed: false,
          sidebarFocusNonce: s.sidebarFocusNonce + 1,
        })),
      // ショートカットヘルプモーダルの開閉状態を設定する。
      setShortcutsHelpOpen: (shortcutsHelpOpen) => set({ shortcutsHelpOpen }),
      // プレゼンテーションモードをトグルする。
      togglePresentation: () => set((s) => ({ presentationMode: !s.presentationMode })),
      // AppShell から呼ばれ、現在のカタログ/スキーマとデフォルト LIMIT の
      // ミラー値をまとめて更新する。
      setShellRuntime: (shellContext, shellDefaultLimit) =>
        set({ shellContext, shellDefaultLimit }),
      // 既存ワークフローをメインエリアで開く。ダッシュボードビューとは排他。
      openWorkflow: (id) => {
        const current = get();
        if (
          current.workflowView?.kind === 'workflow' &&
          current.workflowView.id === id &&
          current.dashboardView === null
        ) {
          return;
        }
        requestDocumentNavigation(() =>
          set({ workflowView: { kind: 'workflow', id }, dashboardView: null }),
        );
      },
      // 新規作成ビューを開く。ダッシュボードビューとは排他。
      openNewWorkflow: () => {
        const current = get();
        if (current.workflowView?.kind === 'new-workflow' && current.dashboardView === null) return;
        requestDocumentNavigation(() =>
          set({ workflowView: { kind: 'new-workflow' }, dashboardView: null }),
        );
      },
      // ワークフロービューを閉じてノートブック表示へ戻す。
      closeWorkflow: () => {
        if (get().workflowView === null) return;
        requestDocumentNavigation(() => set({ workflowView: null }));
      },
      // 既存ダッシュボードをメインエリアで開く。ワークフロービューとは排他。
      openDashboard: (id) => {
        const current = get();
        if (
          current.dashboardView?.kind === 'dashboard' &&
          current.dashboardView.id === id &&
          current.workflowView === null
        ) {
          return;
        }
        requestDocumentNavigation(() =>
          set({ dashboardView: { kind: 'dashboard', id }, workflowView: null }),
        );
      },
      // 新規作成ビューを開く。ワークフロービューとは排他。
      openNewDashboard: () => {
        const current = get();
        if (current.dashboardView?.kind === 'new-dashboard' && current.workflowView === null)
          return;
        requestDocumentNavigation(() =>
          set({ dashboardView: { kind: 'new-dashboard' }, workflowView: null }),
        );
      },
      // ダッシュボードビューを閉じてノートブック表示へ戻す。
      closeDashboard: () => {
        if (get().dashboardView === null) return;
        requestDocumentNavigation(() => set({ dashboardView: null }));
      },
      // AI パネルの開閉をトグルする。
      toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
      // AI パネル幅を設定する。事前に clampAiPanelWidth で許容範囲に丸める。
      setAiPanelWidth: (width) => set({ aiPanelWidth: clampAiPanelWidth(width) }),
    }),
    {
      // localStorage に保存する際のキー名。
      name: principalStorageKey('hubble-ui'),
      // Persist durable layout choices only; palette is transient.
      // 永続化すべき「恒久的なレイアウト選択」のみを対象にする関数。
      // paletteOpen や saveRequest など一時的なフラグは含めない
      // （ページ再読み込みのたびにリセットされてほしいため）。
      partialize: (s) => ({
        theme: s.theme,
        sidebarTab: s.sidebarTab,
        sidebarWidth: s.sidebarWidth,
        sidebarCollapsed: s.sidebarCollapsed,
        aiPanelOpen: s.aiPanelOpen,
        aiPanelWidth: s.aiPanelWidth,
      }),
      // localStorage から状態が復元（rehydrate）された直後に呼ばれるコールバック。
      // 復元されたテーマを DOM にも反映することで、ページ再読み込み後に
      // テーマが正しく適用された状態になるようにする。
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

// Apply the persisted/initial theme synchronously on module load so the very
// first paint matches the stored preference.
// このモジュールが読み込まれた時点（アプリ起動時）で、永続化済み/初期値の
// テーマを同期的に DOM へ適用する。onRehydrateStorage の反映を待たずに
// 即座に適用することで、最初の描画からユーザーの保存済みテーマ設定に
// 一致した見た目になる（フラッシュ・オブ・アンスタイルドコンテンツの防止）。
if (typeof document !== 'undefined') {
  applyTheme(useUiStore.getState().theme);
}

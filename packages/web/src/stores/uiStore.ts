import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * UI store (design.md §3, §10): theme + shell layout state only. Presentation
 * concerns live here; notebook/execution/metadata stores arrive in later phases.
 * Theme is persisted; transient flags (palette open) are not.
 */

export type ThemeMode = 'light' | 'dark';

/** Sidebar sections (design.md §6). */
export type SidebarTab = 'data' | 'notebooks' | 'saved' | 'history';

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 288;

function applyTheme(mode: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/**
 * A transient request to open a notebook save dialog. `mode: 'save'` is the
 * first save of a draft; `mode: 'saveAs'` always prompts. A monotonically
 * increasing `nonce` lets AppShell react even when the same mode is requested
 * twice in a row.
 */
export interface SaveRequest {
  mode: 'save' | 'saveAs';
  nonce: number;
}

interface UiState {
  theme: ThemeMode;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  saveRequest: SaveRequest | null;
  /** Bumped to request the sidebar focus its search field (command palette). */
  sidebarFocusNonce: number;
  /** "Keyboard shortcuts" help modal (design.md §5). */
  shortcutsHelpOpen: boolean;
  /** Presentation mode toggle (design.md §5 stretch: SQL カード表示). */
  presentationMode: boolean;
  /**
   * The shell's current catalog.schema + default LIMIT, mirrored here by AppShell
   * so global shortcuts (run-active-cell) can read them without prop threading.
   */
  shellContext: { catalog?: string; schema?: string };
  shellDefaultLimit: number;

  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  requestSave: (mode: SaveRequest['mode']) => void;
  clearSaveRequest: () => void;
  /** Switch to a sidebar tab, expand it, and focus its search (Go to … commands). */
  gotoSidebar: (tab: SidebarTab) => void;
  setShortcutsHelpOpen: (open: boolean) => void;
  togglePresentation: () => void;
  setShellRuntime: (context: { catalog?: string; schema?: string }, defaultLimit: number) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
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

      setTheme: (mode) => {
        applyTheme(mode);
        set({ theme: mode });
      },
      toggleTheme: () => {
        const next: ThemeMode = get().theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        set({ theme: next });
      },
      setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarCollapsed: false }),
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      requestSave: (mode) =>
        set((s) => ({ saveRequest: { mode, nonce: (s.saveRequest?.nonce ?? 0) + 1 } })),
      clearSaveRequest: () => set({ saveRequest: null }),
      gotoSidebar: (tab) =>
        set((s) => ({
          sidebarTab: tab,
          sidebarCollapsed: false,
          sidebarFocusNonce: s.sidebarFocusNonce + 1,
        })),
      setShortcutsHelpOpen: (shortcutsHelpOpen) => set({ shortcutsHelpOpen }),
      togglePresentation: () => set((s) => ({ presentationMode: !s.presentationMode })),
      setShellRuntime: (shellContext, shellDefaultLimit) =>
        set({ shellContext, shellDefaultLimit }),
    }),
    {
      name: 'hue-fable-ui',
      // Persist durable layout choices only; palette is transient.
      partialize: (s) => ({
        theme: s.theme,
        sidebarTab: s.sidebarTab,
        sidebarWidth: s.sidebarWidth,
        sidebarCollapsed: s.sidebarCollapsed,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

// Apply the persisted/initial theme synchronously on module load so the very
// first paint matches the stored preference.
if (typeof document !== 'undefined') {
  applyTheme(useUiStore.getState().theme);
}

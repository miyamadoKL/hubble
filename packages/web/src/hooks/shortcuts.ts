// Keyboard-shortcut matching (design.md §5 ショートカット). A pure classifier that
// maps a keyboard event (+ the current focus context) to a shell action, kept
// separate from the React hook so the dispatch logic is unit-testable without a
// DOM. The full list is the source of truth for both the runtime dispatcher and
// the "Keyboard shortcuts" help modal.

/** The shell-level actions a global shortcut can trigger. */
export type ShortcutAction =
  | 'run' // Ctrl/Cmd+Enter — run the active cell
  | 'save' // Ctrl/Cmd+S — save the notebook
  | 'format' // Ctrl/Cmd+I or Ctrl+Shift+F — format SQL
  | 'palette' // Ctrl/Cmd+K — command palette
  | 'theme' // Ctrl+Alt+T — toggle theme
  | 'presentation'; // Ctrl+Shift+P — toggle presentation mode

/** Where focus currently sits, so we know whether to defer to the editor. */
export type FocusContext = 'editor' | 'input' | 'none';

/** A lightweight, testable view of the parts of a KeyboardEvent we use. */
export interface KeyChord {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** One row in the help modal + the shortcut registry. */
export interface ShortcutSpec {
  action: ShortcutAction;
  label: string;
  /** Display chips (the platform-agnostic form; ⌘ is shown as Ctrl/Cmd). */
  keys: string[];
}

/** The canonical shortcut list (design.md §5 + the presentation stretch). */
export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'run', label: 'Run the active cell', keys: ['Ctrl', '↵'] },
  { action: 'save', label: 'Save notebook', keys: ['Ctrl', 'S'] },
  { action: 'format', label: 'Format SQL', keys: ['Ctrl', 'I'] },
  { action: 'format', label: 'Format SQL (alternate)', keys: ['Ctrl', 'Shift', 'F'] },
  { action: 'palette', label: 'Command palette', keys: ['Ctrl', 'K'] },
  { action: 'theme', label: 'Toggle light / dark theme', keys: ['Ctrl', 'Alt', 'T'] },
  { action: 'presentation', label: 'Toggle presentation mode', keys: ['Ctrl', 'Shift', 'P'] },
];

const isMod = (e: KeyChord) => e.ctrlKey || e.metaKey;
const key = (e: KeyChord) => e.key.toLowerCase();

/**
 * Classify a key chord into a global action, or null when it isn't a shortcut we
 * own *for that focus context*. The focus context governs run/format:
 *
 *   - `run` is owned by the editor (Monaco command) and the variable input, so we
 *     only handle it globally when focus is *nowhere* (`none`).
 *   - `format` (Ctrl+I / Ctrl+Shift+F) is owned by the editor when an editor is
 *     focused; elsewhere we run it on the last-focused editor.
 *   - `save` / `palette` / `theme` / `presentation` are global in every context.
 */
export function matchShortcut(e: KeyChord, focus: FocusContext): ShortcutAction | null {
  const k = key(e);

  // Palette — Ctrl/Cmd+K, no Alt/Shift.
  if (isMod(e) && !e.altKey && !e.shiftKey && k === 'k') return 'palette';

  // Save — Ctrl/Cmd+S, no Alt/Shift.
  if (isMod(e) && !e.altKey && !e.shiftKey && k === 's') return 'save';

  // Theme — Ctrl+Alt+T (no Cmd needed; matches design + avoids browser conflicts).
  if (e.ctrlKey && e.altKey && k === 't') return 'theme';

  // Presentation — Ctrl/Cmd+Shift+P.
  if (isMod(e) && e.shiftKey && k === 'p') return 'presentation';

  // Format — Ctrl/Cmd+Shift+F everywhere; Ctrl/Cmd+I only when not in the editor
  // (the editor binds Ctrl+I itself, so let it handle that locally).
  if (isMod(e) && e.shiftKey && !e.altKey && k === 'f') return 'format';
  if (isMod(e) && !e.shiftKey && !e.altKey && k === 'i' && focus !== 'editor') return 'format';

  // Run — only when focus is nowhere (editor + variable input own it otherwise).
  if (isMod(e) && !e.altKey && !e.shiftKey && k === 'enter' && focus === 'none') return 'run';

  return null;
}

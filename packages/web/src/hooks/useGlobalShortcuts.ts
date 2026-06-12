import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';
import { saveActiveNotebook, runActiveSqlCell } from '../notebook';
import { getActiveEditor } from '../editor/activeEditor';
import { formatEditor } from '../editor/formatter';
import { matchShortcut, type FocusContext, type KeyChord } from './shortcuts';

/**
 * Global keyboard shortcuts for the shell (design.md §5 ショートカット). The full
 * audit + completion:
 *
 *   - Ctrl/Cmd+K  → command palette      (any focus)
 *   - Ctrl/Cmd+S  → save notebook        (any focus; draft → name modal)
 *   - Ctrl+Alt+T  → toggle theme         (any focus)
 *   - Ctrl/Cmd+Shift+F → format SQL      (any focus; targets the last editor)
 *   - Ctrl/Cmd+I  → format SQL           (only when NOT in an editor — the editor
 *                                         binds Ctrl+I locally itself)
 *   - Ctrl/Cmd+Enter → run active cell   (only when focus is nowhere — the editor
 *                                         and the variable inputs own it otherwise)
 *   - Ctrl/Cmd+Shift+P → presentation    (any focus)
 *
 * The hook listens on the capture phase so it can intercept chords (notably
 * Ctrl+K, which Monaco otherwise claims as a chord prefix) before the editor.
 * `matchShortcut` (pure, tested) decides the action from the chord + focus.
 */
export function useGlobalShortcuts(): void {
  const togglePalette = useUiStore((s) => s.togglePalette);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const togglePresentation = useUiStore((s) => s.togglePresentation);
  const requestSave = useUiStore((s) => s.requestSave);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const focus = focusContext(e.target);
      const chord: KeyChord = {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      };
      const action = matchShortcut(chord, focus);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();

      switch (action) {
        case 'palette':
          togglePalette();
          break;
        case 'save':
          // A draft needs a name (modal); a saved notebook PUTs immediately.
          void saveActiveNotebook().then((result) => {
            if ('needsName' in result) requestSave('save');
          });
          break;
        case 'theme':
          toggleTheme();
          break;
        case 'presentation':
          togglePresentation();
          break;
        case 'format': {
          const editor = getActiveEditor()?.editor;
          if (editor) {
            editor.focus();
            formatEditor(editor);
          }
          break;
        }
        case 'run':
          runActiveSqlCell(currentContext(), currentDefaultLimit());
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [togglePalette, toggleTheme, togglePresentation, requestSave]);
}

/** Classify the focused element so run/format defer to the editor / inputs. */
function focusContext(target: EventTarget | null): FocusContext {
  if (!(target instanceof HTMLElement)) return 'none';
  // Monaco's editable surface is a textarea inside `.monaco-editor`.
  if (target.closest('.monaco-editor')) return 'editor';
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable) {
    return 'input';
  }
  return 'none';
}

// The shell context + default limit are read from the UI store's transient
// snapshot so the global run uses the same catalog.schema as the toolbar. These
// are set by AppShell on every context change.
function currentContext(): { catalog?: string; schema?: string } {
  return useUiStore.getState().shellContext;
}
function currentDefaultLimit(): number {
  return useUiStore.getState().shellDefaultLimit;
}

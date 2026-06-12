// SqlEditor: the Monaco-backed SQL cell editor (design.md §6). Auto-height —
// grows with content, minimum 4 lines — so notebook cells size to their query.
// Monaco is loaded lazily (its own chunk) and the Trino language is registered
// on first mount; diagnostics (markers + decorations + format/execute commands)
// are attached per editor. The theme tracks the app's light/dark switch.

import { useEffect, useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import { loadMonaco } from './monacoLoader';
import {
  registerTrinoLanguage,
  attachDiagnostics,
  TRINO_LANGUAGE_ID,
} from './registerTrinoLanguage';
import { applyFableTheme } from './theme';
import { useEditorRuntime } from './EditorRuntime';
import { useUiStore } from '../stores/uiStore';
import './editor.css';

const LINE_HEIGHT = 20;
const MIN_LINES = 4;
const VERTICAL_PADDING = 16; // top + bottom editor padding
const MAX_LINES = 40;

export interface SqlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /**
   * Ctrl/Cmd+Enter handler. Receives the live editor so the caller can read the
   * current selection / caret to decide the execution unit (design.md §5).
   */
  onExecute?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  /** Called once the editor + Monaco namespace are ready (for markers/gutter). */
  onReady?: (editor: monaco.editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => void;
  /** Read-only display (e.g. history preview). */
  readOnly?: boolean;
  ariaLabel?: string;
}

export function SqlEditor({
  value,
  onChange,
  onExecute,
  onReady,
  readOnly,
  ariaLabel,
}: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const [height, setHeight] = useState(MIN_LINES * LINE_HEIGHT + VERTICAL_PADDING);
  const [ready, setReady] = useState(false);

  const runtime = useEditorRuntime();
  const theme = useUiStore((s) => s.theme);

  // Stable refs for callbacks so the editor-creation effect doesn't depend on
  // (and re-run for) changing props. Updated in an effect — never during render
  // (react-hooks/refs).
  const onChangeRef = useRef(onChange);
  const onExecuteRef = useRef(onExecute);
  const onReadyRef = useRef(onReady);
  const themeRef = useRef(theme);
  useEffect(() => {
    onChangeRef.current = onChange;
    onExecuteRef.current = onExecute;
    onReadyRef.current = onReady;
    themeRef.current = theme;
  });

  useEffect(() => {
    let disposed = false;
    let editor: monaco.editor.IStandaloneCodeEditor | undefined;
    let diagnostics: monaco.IDisposable | undefined;
    let changeSub: monaco.IDisposable | undefined;
    let sizeSub: monaco.IDisposable | undefined;

    loadMonaco().then((monacoNs) => {
      if (disposed || !hostRef.current) return;
      monacoRef.current = monacoNs;

      registerTrinoLanguage(monacoNs, {
        cache: runtime.cache,
        getContext: runtime.getContext,
        getTheme: () => themeRef.current,
        onExecute: (ed) =>
          onExecuteRef.current?.(ed as monaco.editor.IStandaloneCodeEditor),
      });

      editor = monacoNs.editor.create(hostRef.current, {
        value,
        language: TRINO_LANGUAGE_ID,
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        // Statement status indicators (idle/active/executing/done/failed) render
        // in the glyph margin via decorations (design.md §5 ガター).
        glyphMargin: true,
        folding: false,
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        lineHeight: LINE_HEIGHT,
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 8 },
        scrollbar: { alwaysConsumeMouseWheel: false, vertical: 'auto' },
        overviewRulerLanes: 0,
        wordWrap: 'off',
        ariaLabel,
      });
      editorRef.current = editor;

      // Dev-only test affordance: expose live editors so Playwright can set
      // content via the Monaco model (typing multi-line SQL is unreliable —
      // auto-indent + suggest acceptance scramble it). Tree-shaken from prod.
      // The editor is also attached to its host element so tests can resolve the
      // editor of the *nth visible cell* by DOM order (the global array is
      // mount-order and goes stale across cell delete/reorder).
      if (import.meta.env.DEV) {
        const w = window as unknown as { __fableEditors?: unknown[] };
        (w.__fableEditors ??= []).push(editor);
        if (hostRef.current) {
          (hostRef.current as unknown as { __fableEditor?: unknown }).__fableEditor = editor;
        }
      }

      const syncHeight = () => {
        if (!editor) return;
        const lineCount = editor.getModel()?.getLineCount() ?? MIN_LINES;
        const lines = Math.min(MAX_LINES, Math.max(MIN_LINES, lineCount));
        setHeight(lines * LINE_HEIGHT + VERTICAL_PADDING);
      };

      changeSub = editor.onDidChangeModelContent(() => {
        onChangeRef.current?.(editor?.getValue() ?? '');
        syncHeight();
      });
      sizeSub = editor.onDidContentSizeChange(syncHeight);

      diagnostics = attachDiagnostics(monacoNs, editor, {
        cache: runtime.cache,
        getContext: runtime.getContext,
        getTheme: () => themeRef.current,
        onExecute: (ed) =>
          onExecuteRef.current?.(ed as monaco.editor.IStandaloneCodeEditor),
      });

      onReadyRef.current?.(editor, monacoNs);

      syncHeight();
      setReady(true);
    });

    return () => {
      disposed = true;
      diagnostics?.dispose();
      changeSub?.dispose();
      sizeSub?.dispose();
      editor?.dispose();
      editorRef.current = null;
    };
    // Create the editor once; props are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the model in sync when the controlled value changes externally.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  // Re-derive the Monaco theme when the app theme switches.
  useEffect(() => {
    if (monacoRef.current) applyFableTheme(monacoRef.current, theme);
  }, [theme]);

  return (
    <div
      ref={hostRef}
      className="w-full overflow-hidden"
      style={{ height }}
      data-ready={ready ? 'true' : 'false'}
      data-testid="sql-editor"
    />
  );
}

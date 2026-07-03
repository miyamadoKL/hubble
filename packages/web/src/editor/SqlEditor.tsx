// SqlEditor: the Monaco-backed SQL cell editor (design.md §6). Auto-height —
// grows with content, minimum 4 lines — so notebook cells size to their query.
// Monaco is loaded lazily (its own chunk) and the Trino language is registered
// on first mount; diagnostics (markers + decorations + format/execute commands)
// are attached per editor. The theme tracks the app's light/dark switch.
//
// ---- ファイル概要（日本語） ----
// ノートブックの SQL セルを表す Monaco ベースのエディターコンポーネント。内容量に応じて
// 高さが自動で伸びる（最小 4 行）ため、セルはクエリの長さに合わせて自然にサイズが決まる。
// Monaco 本体は初回マウント時に遅延ロード（独自チャンク）され、Trino 言語もこのタイミングで
// 登録される。診断機能（構文エラーマーカー、テーブル参照の装飾、整形/実行コマンド）は
// エディターインスタンスごとにアタッチする。テーマはアプリのライト/ダーク切り替えに追従する。

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

/** SqlEditor コンポーネントの props。 */
export interface SqlEditorProps {
  /** 制御コンポーネントとしてのエディターの内容（外部から変更されたら model に反映する）。 */
  value: string;
  /** 内容が変わるたびに呼ばれるハンドラ（親側の状態を更新する）。 */
  onChange?: (value: string) => void;
  /**
   * Ctrl/Cmd+Enter handler. Receives the live editor so the caller can read the
   * current selection / caret to decide the execution unit (design.md §5).
   */
  /**
   * Ctrl/Cmd+Enter が押されたときのハンドラ。実体のエディターを受け取るので、呼び出し側は
   * 現在の選択範囲/カーソル位置から実行対象（選択範囲 or ステートメント単位）を判断できる。
   */
  onExecute?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  /** Called once the editor + Monaco namespace are ready (for markers/gutter). */
  /** エディターと Monaco 名前空間の準備ができた時点で 1 度だけ呼ばれる（マーカー/ガター用）。 */
  onReady?: (editor: monaco.editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => void;
  /** Read-only display (e.g. history preview). */
  /** 読み取り専用表示（例: 履歴プレビュー）。 */
  readOnly?: boolean;
  /** false のとき Monaco 標準 SQL モードを使う（Trino ANTLR 機能を無効化）。 */
  trinoLanguage?: boolean;
  ariaLabel?: string;
}

/**
 * Monaco ベースの SQL セルエディター。制御コンポーネントとして `value` を受け取り、
 * 内部で Monaco のエディターインスタンス/モデルを生成し、保持する。エディター本体の
 * 生成は初回マウント時の 1 回のみ行い（props の変更では作り直さない）、以降の props の
 * 変化は ref 経由のコールバックや個別の useEffect で反映する。
 */
export function SqlEditor({
  value,
  onChange,
  onExecute,
  onReady,
  readOnly,
  trinoLanguage = true,
  ariaLabel,
}: SqlEditorProps) {
  // エディターをマウントする DOM ホスト要素。
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 生成された Monaco エディターインスタンス本体。
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // 遅延ロードした Monaco 名前空間（テーマ再適用などで使う）。
  const monacoRef = useRef<typeof monaco | null>(null);
  // 自動計算されるエディターの高さ（px）。行数に応じて増減する。
  const [height, setHeight] = useState(MIN_LINES * LINE_HEIGHT + VERTICAL_PADDING);
  // Monaco のロードとエディター生成が完了したかどうか（data-ready 属性に反映しテスト等が待てるようにする）。
  const [ready, setReady] = useState(false);

  // 全エディターで共有するランタイム依存（スキーマキャッシュと catalog.schema コンテキスト）。
  const runtime = useEditorRuntime();
  const theme = useUiStore((s) => s.theme);

  // Stable refs for callbacks so the editor-creation effect doesn't depend on
  // (and re-run for) changing props. Updated in an effect — never during render
  // (react-hooks/refs).
  // props が変わってもエディター生成用 useEffect を再実行させないよう、コールバックを
  // ref に保持する。ref の更新は必ず useEffect 内で行い、レンダー中には行わない
  // （react-hooks/refs のルールに従う）。
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

  // エディター本体の生成と破棄を担う唯一の effect。マウント時に一度だけ実行され、
  // アンマウント時にすべてのリソース（購読とエディターインスタンス）を解放する。
  useEffect(() => {
    let disposed = false;
    let editor: monaco.editor.IStandaloneCodeEditor | undefined;
    let diagnostics: monaco.IDisposable | undefined;
    let changeSub: monaco.IDisposable | undefined;
    let sizeSub: monaco.IDisposable | undefined;

    // Monaco を遅延ロードしてからエディターを生成する。ロード完了前にアンマウントされた
    // 場合は disposed フラグで何もしない。
    loadMonaco().then((monacoNs) => {
      if (disposed || !hostRef.current) return;
      monacoRef.current = monacoNs;

      const useTrino = trinoLanguage && runtime.isTrinoLanguage();
      if (useTrino) {
        // Trino 言語（tokenizer/補完/ホバー）を Monaco 名前空間へ登録する（冪等）。
        registerTrinoLanguage(monacoNs, {
          cache: runtime.cache,
          getContext: runtime.getContext,
          getTheme: () => themeRef.current,
          onExecute: (ed) =>
            onExecuteRef.current?.(ed as monaco.editor.IStandaloneCodeEditor),
        });
      }

      // Monaco エディター本体を DOM ホストに生成する（各種表示オプションを指定）。
      editor = monacoNs.editor.create(hostRef.current, {
        value,
        language: useTrino ? TRINO_LANGUAGE_ID : 'sql',
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

      // 現在の行数から高さ(px)を再計算する（MIN_LINES〜MAX_LINES にクランプ）。
      const syncHeight = () => {
        if (!editor) return;
        const lineCount = editor.getModel()?.getLineCount() ?? MIN_LINES;
        const lines = Math.min(MAX_LINES, Math.max(MIN_LINES, lineCount));
        setHeight(lines * LINE_HEIGHT + VERTICAL_PADDING);
      };

      // 内容が変わるたびに親へ通知し、高さも再計算する。
      changeSub = editor.onDidChangeModelContent(() => {
        onChangeRef.current?.(editor?.getValue() ?? '');
        syncHeight();
      });
      sizeSub = editor.onDidContentSizeChange(syncHeight);

      // Trino 選択時のみ構文エラーマーカー等を配線する。
      if (useTrino) {
        diagnostics = attachDiagnostics(monacoNs, editor, {
          cache: runtime.cache,
          getContext: runtime.getContext,
          getTheme: () => themeRef.current,
          onExecute: (ed) =>
            onExecuteRef.current?.(ed as monaco.editor.IStandaloneCodeEditor),
        });
      }

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
  // 制御コンポーネントとして、外部から value が変更された場合はモデルへ反映する
  // （エディター自身の入力による変更ではループしないよう、値が違う場合のみ setValue する）。
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  // Re-derive the Monaco theme when the app theme switches.
  // アプリのテーマ（ライト/ダーク）が切り替わったら、Monaco のテーマを再構築して適用する。
  useEffect(() => {
    if (monacoRef.current) applyFableTheme(monacoRef.current, theme);
  }, [theme]);

  // データソース切り替えで Trino / 標準 SQL モードを切り替える。
  useEffect(() => {
    const editor = editorRef.current;
    const monacoNs = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monacoNs || !model) return;
    const useTrino = trinoLanguage && runtime.isTrinoLanguage();
    monacoNs.editor.setModelLanguage(model, useTrino ? TRINO_LANGUAGE_ID : 'sql');
  }, [trinoLanguage, runtime]);

  return (
    // Monaco のマウント先ホスト要素。高さは自動計算した値をインラインスタイルで指定する。
    // data-ready / data-testid は Playwright などのテストがエディターの初期化完了を
    // 待ち合わせたり要素を特定したりするためのフック。
    <div
      ref={hostRef}
      className="w-full overflow-hidden"
      style={{ height }}
      data-ready={ready ? 'true' : 'false'}
      data-testid="sql-editor"
    />
  );
}

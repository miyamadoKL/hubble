// SqlEditor: the Monaco-backed SQL cell editor. Auto-height —
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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import { loadMonaco } from './monacoLoader';
import {
  registerTrinoLanguage,
  attachDiagnostics,
  TRINO_LANGUAGE_ID,
  TRINO_MARKER_OWNER,
} from './registerTrinoLanguage';
import { applyFableTheme } from './theme';
import { useEditorRuntime } from './EditorRuntime';
import { useUiStore } from '../stores/uiStore';
import { VerticalResizeHandle } from '../components/common/VerticalResizeHandle';
import {
  EDITOR_HEIGHT_MIN,
  EDITOR_LINE_HEIGHT,
  EDITOR_MAX_LINES,
  EDITOR_MIN_LINES,
  EDITOR_VERTICAL_PADDING,
  beginEditorHeightResize,
  clampEditorHeight,
  editorHeightMax,
  getEditorHeight,
  resetEditorHeight,
  setEditorHeight,
} from '../notebook/editorHeight';
import './editor.css';

// 自動伸縮（内容連動）時の行高/最小行数/最大行数/上下パディングは editorHeight.ts の
// 定数をそのまま使う（手動オーバーライドの下限や、syncHeight が行数だけから
// 求める生の自動高さの計算と一致させるため）。
const LINE_HEIGHT = EDITOR_LINE_HEIGHT;
const MIN_LINES = EDITOR_MIN_LINES;
const VERTICAL_PADDING = EDITOR_VERTICAL_PADDING; // エディター上下の padding
const MAX_LINES = EDITOR_MAX_LINES;

/** SqlEditor コンポーネントの props。 */
export interface SqlEditorProps {
  /** 制御コンポーネントとしてのエディターの内容（外部から変更されたら model に反映する）。 */
  value: string;
  /** 内容が変わるたびに呼ばれるハンドラ（親側の状態を更新する）。 */
  onChange?: (value: string) => void;
  /**
   * Ctrl/Cmd+Enter handler. Receives the live editor so the caller can read the
   * current selection / caret to decide the execution unit.
   */
  /**
   * Ctrl/Cmd+Enter が押されたときのハンドラ。実体のエディターを受け取るので、呼び出し側は
   * 現在の選択範囲/カーソル位置から実行対象（選択範囲 or ステートメント単位）を判断できる。
   */
  onExecute?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  /** Called once the editor + Monaco namespace are ready (for markers/gutter). */
  /** エディターと Monaco 名前空間の準備ができた時点で 1 度だけ呼ばれる（マーカー/ガター用）。 */
  onReady?: (
    editor: monaco.editor.IStandaloneCodeEditor,
    monaco: typeof import('monaco-editor'),
  ) => void;
  /** Read-only display (e.g. history preview). */
  /** 読み取り専用表示（例: 履歴プレビュー）。 */
  readOnly?: boolean;
  /** false のとき Monaco 標準 SQL モードを使う（Trino ANTLR 機能を無効化）。 */
  trinoLanguage?: boolean;
  ariaLabel?: string;
  /**
   * 高さの手動オーバーライドを永続化するためのノートブックID。高さハンドル自体は
   * notebookId/cellId の有無に関わらず常に表示され、ドラッグ操作もできる
   * （ResultGrid の結果表示域ハンドルと同じ設計）。両方揃っている場合のみ、
   * 調整結果を localStorage へ永続化する。
   */
  notebookId?: string;
  /** 高さの手動オーバーライドを永続化するためのセルID。notebookId とセットで指定する。 */
  cellId?: string;
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
  notebookId,
  cellId,
}: SqlEditorProps) {
  // エディターをマウントする DOM ホスト要素。
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 生成された Monaco エディターインスタンス本体。
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // 遅延ロードした Monaco 名前空間（テーマ再適用などで使う）。
  const monacoRef = useRef<typeof monaco | null>(null);
  // 自動計算されるエディターの高さ（px）。行数に応じて増減する。手動オーバーライド中
  // （customHeight !== null）でも計算自体は続けるが、実際の描画には使わない
  // （オーバーライド解除時に直近の内容量へ自然に戻れるようにするため）。
  const [height, setHeight] = useState(MIN_LINES * LINE_HEIGHT + VERTICAL_PADDING);
  // 手動で明示指定された高さ（px）。null なら「未調整」で、内容量に応じた自動伸縮
  // （height ステート）をそのまま使う。初期値は localStorage から一度だけ読み出す
  // （notebookId/cellId 未指定時は常に null）。resultHeight.ts / ResultGrid と同じ設計で、
  // 読み出し側でマウント時点のビューポート高さに応じてクランプする。
  const [customHeight, setCustomHeight] = useState<number | null>(() => {
    if (!notebookId || !cellId) return null;
    const stored = getEditorHeight(notebookId, cellId);
    if (stored === null) return null;
    return clampEditorHeight(stored, typeof window !== 'undefined' ? window.innerHeight : stored);
  });
  // 高さドラッグ中の pointer リスナー解除関数。ドラッグ中でなければ null。
  const heightDragCleanupRef = useRef<(() => void) | null>(null);
  // unmount 時にドラッグ中のリスナーが残らないようにする。
  useEffect(() => () => heightDragCleanupRef.current?.(), []);
  // Monaco のロードとエディター生成が完了したかどうか（data-ready 属性に反映しテスト等が待てるようにする）。
  const [ready, setReady] = useState(false);
  // Trino 診断ループ（attachDiagnostics の返り値）。データソース切り替え時に dispose する。
  const diagnosticsRef = useRef<monaco.IDisposable | undefined>(undefined);

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
  // Monaco の遅延ロード中に value が変わっても、生成時には直近の確定値を使う。
  const valueRef = useRef(value);
  useLayoutEffect(() => {
    valueRef.current = value;
  }, [value]);
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
    let changeSub: monaco.IDisposable | undefined;
    let sizeSub: monaco.IDisposable | undefined;

    // Monaco を遅延ロードしてからエディターを生成する。ロード完了前にアンマウントされた
    // 場合は disposed フラグで何もしない。
    loadMonaco().then((monacoNs) => {
      if (disposed || !hostRef.current) return;
      monacoRef.current = monacoNs;

      const useTrino = trinoLanguage && runtime.isTrinoLanguage();

      // Monaco エディター本体を DOM ホストに生成する（各種表示オプションを指定）。
      editor = monacoNs.editor.create(hostRef.current, {
        value: valueRef.current,
        language: useTrino ? TRINO_LANGUAGE_ID : 'sql',
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        // Statement status indicators (idle/active/executing/done/failed) render
        // in the glyph margin via decorations (ガター).
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
      // さらに editorHeightMax(window.innerHeight)（手動オーバーライドの上限=80vh）とも
      // min() を取る。これを怠ると、80vhが40行分の高さ（EDITOR_AUTO_HEIGHT_MAX=816px）を
      // 下回る低いビューポートで、自動伸縮の高さが手動オーバーライドの許容レンジより
      // 大きくなってしまい、矢印キー1回や移動量ゼロのドラッグで手動調整に切り替えた瞬間に
      // 大きくジャンプする（例: 768px高の画面では80vh=614pxなので、クランプなしだと
      // 816→614へ一気に縮む）。
      const syncHeight = () => {
        if (!editor) return;
        const lineCount = editor.getModel()?.getLineCount() ?? MIN_LINES;
        const lines = Math.min(MAX_LINES, Math.max(MIN_LINES, lineCount));
        const rawHeight = lines * LINE_HEIGHT + VERTICAL_PADDING;
        const viewportCap = editorHeightMax(
          typeof window !== 'undefined' ? window.innerHeight : rawHeight,
        );
        setHeight(Math.min(rawHeight, viewportCap));
      };

      // 内容が変わるたびに親へ通知し、高さも再計算する。
      changeSub = editor.onDidChangeModelContent(() => {
        onChangeRef.current?.(editor?.getValue() ?? '');
        syncHeight();
      });
      sizeSub = editor.onDidContentSizeChange(syncHeight);

      onReadyRef.current?.(editor, monacoNs);

      syncHeight();
      setReady(true);
    });

    return () => {
      disposed = true;
      diagnosticsRef.current?.dispose();
      diagnosticsRef.current = undefined;
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

  // データソース切り替えで Trino 言語機能（補完と診断）と Monaco の language id を同期する。
  useEffect(() => {
    const editor = editorRef.current;
    const monacoNs = monacoRef.current;
    const model = editor?.getModel();
    if (!ready || !editor || !monacoNs || !model) return;

    const useTrino = trinoLanguage && runtime.isTrinoLanguage();
    const trinoDeps = {
      cache: runtime.cache,
      getContext: runtime.getContext,
      getTheme: () => themeRef.current,
      onExecute: (ed: monaco.editor.ICodeEditor) =>
        onExecuteRef.current?.(ed as monaco.editor.IStandaloneCodeEditor),
    };

    diagnosticsRef.current?.dispose();
    diagnosticsRef.current = undefined;

    if (useTrino) {
      registerTrinoLanguage(monacoNs, trinoDeps);
      diagnosticsRef.current = attachDiagnostics(monacoNs, editor, trinoDeps);
      monacoNs.editor.setModelLanguage(model, TRINO_LANGUAGE_ID);
    } else {
      monacoNs.editor.setModelMarkers(model, TRINO_MARKER_OWNER, []);
      monacoNs.editor.setModelLanguage(model, 'sql');
    }
  }, [trinoLanguage, runtime, ready]);

  // 高さを変更し、ノートブックID/セルIDが揃っていれば localStorage へ永続化する。
  // height が null なら「未調整」へ戻す（内容量に応じた自動伸縮の再開）。
  const applyHeight = (nextHeight: number | null) => {
    const clamped =
      nextHeight === null
        ? null
        : clampEditorHeight(
            nextHeight,
            typeof window !== 'undefined' ? window.innerHeight : nextHeight,
          );
    setCustomHeight(clamped);
    if (!notebookId || !cellId) return;
    if (clamped === null) resetEditorHeight(notebookId, cellId);
    else setEditorHeight(notebookId, cellId, clamped);
  };

  // 高さリサイズハンドルの pointerdown で呼ばれる。ドラッグ開始時の高さは、
  // 未調整であれば現在の自動伸縮の高さ（height ステート）から連続的に変化させる。
  const startHeightDrag = (e: React.PointerEvent) => {
    heightDragCleanupRef.current?.();
    const startHeight = customHeight ?? height;
    const cleanup = beginEditorHeightResize(
      e.clientY,
      startHeight,
      applyHeight,
      () => {
        if (heightDragCleanupRef.current === cleanup) heightDragCleanupRef.current = null;
      },
      e.pointerId,
    );
    heightDragCleanupRef.current = cleanup;
  };

  // 実際に描画する高さ: オーバーライド中はその明示値、そうでなければ内容連動の自動値。
  const renderedHeight = customHeight ?? height;

  return (
    <div className="flex flex-col">
      {/* Monaco のマウント先ホスト要素。高さはオーバーライド中は明示値、そうでなければ
          自動計算した値をインラインスタイルで指定する。data-ready / data-testid は
          Playwright などのテストがエディターの初期化完了を待ち合わせたり要素を
          特定したりするためのフック。 */}
      <div
        ref={hostRef}
        className="w-full overflow-hidden"
        style={{ height: renderedHeight }}
        data-ready={ready ? 'true' : 'false'}
        data-testid="sql-editor"
      />
      {/* エディター高さの手動オーバーライド用ハンドル。ドラッグ、ダブルクリックでの
          自動伸縮への復帰、フォーカス時の上下矢印キー（16px刻み）による調整に対応する。
          ResultGrid の結果表示域ハンドルと同じ見た目/挙動を共有する。 */}
      <VerticalResizeHandle
        ariaLabel="SQLエディターの高さを調整"
        valueNow={renderedHeight}
        valueMin={EDITOR_HEIGHT_MIN}
        valueMax={editorHeightMax(typeof window !== 'undefined' ? window.innerHeight : 0)}
        onPointerDown={startHeightDrag}
        onDoubleClick={() => applyHeight(null)}
        onAdjust={(delta) => applyHeight(renderedHeight + delta)}
      />
    </div>
  );
}

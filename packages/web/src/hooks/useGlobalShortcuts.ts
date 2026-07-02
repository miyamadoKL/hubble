// --- ファイル概要（日本語） ---
// アプリ全体（シェルレベル）で有効なキーボードショートカットを実際に window に登録し、
// キー入力を shortcuts.ts の matchShortcut で判定してから、対応する処理
// （パレット表示、保存、テーマ切り替え、SQL整形、セル実行、プレゼンテーションモード切り替え）
// を呼び出す React hook。shortcuts.ts が「何のショートカットか」の判定ロジックを持つのに対し、
// このファイルは「実際にイベントを購読し、判定結果に応じてアプリの状態を変更する」実行部分を担う。

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
/**
 * シェル全体で有効なグローバルキーボードショートカットを登録する hook（design.md §5）。
 * 副作用として window に keydown リスナーを登録するだけで、戻り値は持たない（void）。
 *
 * 対応するショートカット:
 *   - Ctrl/Cmd+K            → コマンドパレット表示（フォーカス位置を問わない）
 *   - Ctrl/Cmd+S            → ノートブック保存（ドラフトの場合は名前入力モーダルへ）
 *   - Ctrl+Alt+T            → テーマ切り替え（フォーカス位置を問わない）
 *   - Ctrl/Cmd+Shift+F      → SQL整形（フォーカス位置を問わず、最後にフォーカスしたエディタが対象）
 *   - Ctrl/Cmd+I            → SQL整形（エディタにフォーカスがないときのみ。エディタ自身が
 *                              Ctrl+I をローカルにバインドしているため）
 *   - Ctrl/Cmd+Enter        → アクティブセルの実行（フォーカスがどこにもないときのみ。
 *                              エディタや変数入力欄は自前で処理する）
 *   - Ctrl/Cmd+Shift+P      → プレゼンテーションモード切り替え（フォーカス位置を問わない）
 *
 * イベントはキャプチャフェーズで購読している。これは Monaco エディタが Ctrl+K などの
 * コード補完チョード（複数キーの組み合わせ）を先取りしてしまうのを防ぐため、
 * バブリングフェーズより先にこのハンドラで割り込む狙いがある。
 * 実際の「このキー入力がどのアクションに該当するか」の判定は、テスト済みの純粋関数である
 * shortcuts.ts の matchShortcut に委譲している。
 */
export function useGlobalShortcuts(): void {
  // Zustand ストア（uiStore）から、各ショートカットが呼び出す状態更新関数を取得する。
  // togglePalette: コマンドパレットの表示/非表示を切り替える。
  const togglePalette = useUiStore((s) => s.togglePalette);
  // toggleTheme: ライト/ダークテーマを切り替える。
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  // togglePresentation: プレゼンテーションモードの表示/非表示を切り替える。
  const togglePresentation = useUiStore((s) => s.togglePresentation);
  // requestSave: 保存に名前入力が必要な場合（ドラフトノートブック）にモーダル表示を要求する。
  const requestSave = useUiStore((s) => s.requestSave);

  useEffect(() => {
    // keydown イベントハンドラ本体。window に対して capture: true で登録するため、
    // 子要素（エディタ等）のイベントハンドラより先にこの関数が呼ばれる。
    const onKeyDown = (e: KeyboardEvent) => {
      // イベント発生元の要素から、現在のフォーカス位置（editor / input / none）を分類する。
      const focus = focusContext(e.target);
      // DOM の KeyboardEvent から、shortcuts.ts の判定に必要なプロパティだけを抜き出す。
      const chord: KeyChord = {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      };
      // 純粋関数 matchShortcut にキー入力とフォーカス位置を渡し、該当するアクションを判定する。
      const action = matchShortcut(chord, focus);
      // どのショートカットにも該当しなければ何もせず、ブラウザ/エディタのデフォルト動作に委ねる。
      if (!action) return;
      // ショートカットとして処理することが確定したので、ブラウザのデフォルト動作
      // （例: Ctrl+S でブラウザの保存ダイアログが開く等）を抑止し、他のリスナーへの伝播も止める。
      e.preventDefault();
      e.stopPropagation();

      // 判定されたアクションに応じて、対応する処理を実行する。
      switch (action) {
        case 'palette':
          // コマンドパレットの表示状態をトグルする。
          togglePalette();
          break;
        case 'save':
          // A draft needs a name (modal); a saved notebook PUTs immediately.
          // ドラフト（未保存）のノートブックは名前入力が必要なのでモーダルを要求し、
          // 既に保存済みのノートブックはそのまま PUT で上書き保存する。
          // saveActiveNotebook が返す結果に needsName プロパティが含まれる場合、
          // 名前未設定のドラフトだったと判断して requestSave('save') でモーダルを開く。
          void saveActiveNotebook().then((result) => {
            if ('needsName' in result) requestSave('save');
          });
          break;
        case 'theme':
          // ライト/ダークテーマを切り替える。
          toggleTheme();
          break;
        case 'presentation':
          // プレゼンテーションモードの表示状態をトグルする。
          togglePresentation();
          break;
        case 'format': {
          // 最後にフォーカスされていたエディタインスタンスを取得し、フォーカスを戻してから整形する。
          const editor = getActiveEditor()?.editor;
          if (editor) {
            editor.focus();
            // formatEditor（../editor/formatter）で SQL 文の整形処理を実行する。
            formatEditor(editor);
          }
          break;
        }
        case 'run':
          // アクティブな SQL セルを実行する。実行対象のカタログ/スキーマと、
          // 自動付与する LIMIT のデフォルト値は、UI ストアのスナップショットから取得する
          // （ツールバーが選択している内容と一致させるため）。
          runActiveSqlCell(currentContext(), currentDefaultLimit());
          break;
      }
    };
    // capture フェーズで keydown を購読することで、Monaco エディタ等より先にショートカットを捕捉する。
    window.addEventListener('keydown', onKeyDown, { capture: true });
    // クリーンアップ: アンマウント時、または依存配列の値が変わって effect が再実行される際に
    // 古いリスナーを解除し、リスナーの多重登録を防ぐ。
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [togglePalette, toggleTheme, togglePresentation, requestSave]);
}

/** Classify the focused element so run/format defer to the editor / inputs. */
/**
 * 現在フォーカスされている DOM 要素を分類し、run/format のようにフォーカス位置によって
 * 挙動を変えるショートカットが、エディタや入力欄に処理を委ねるべきかどうかを判断できるようにする。
 *
 * @param target - keydown イベントの target（イベント発生元の要素）。
 * @returns 'editor'（Monaco エディタ内）, 'input'（それ以外のフォーム要素）,
 *   'none'（それ以外＝フォーカスなしとみなす）のいずれか。
 */
function focusContext(target: EventTarget | null): FocusContext {
  if (!(target instanceof HTMLElement)) return 'none';
  // Monaco's editable surface is a textarea inside `.monaco-editor`.
  // Monaco エディタの実体（編集可能な textarea）は `.monaco-editor` 要素の中にあるため、
  // 祖先要素にそのクラスを持つものがあればエディタにフォーカスがあると判断する。
  if (target.closest('.monaco-editor')) return 'editor';
  const tag = target.tagName;
  // input / select / textarea、あるいは contenteditable な要素であれば「入力欄にフォーカス」とみなす。
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable) {
    return 'input';
  }
  // 上記のどれにも該当しなければ、フォーカスは実質どこにもない（'none'）とみなす。
  return 'none';
}

// The shell context + default limit are read from the UI store's transient
// snapshot so the global run uses the same catalog.schema as the toolbar. These
// are set by AppShell on every context change.
// シェルの実行コンテキスト（カタログ/スキーマ）とデフォルト LIMIT は、UI ストアの
// スナップショットから直接読み取る。これにより、グローバルショートカットで実行した際にも
// ツールバーが表示しているのと同じ catalog.schema が使われるようにしている。
// これらの値は AppShell がコンテキスト変更のたびに UI ストアへ書き込んでいる。
function currentContext(): { catalog?: string; schema?: string } {
  return useUiStore.getState().shellContext;
}
function currentDefaultLimit(): number {
  return useUiStore.getState().shellDefaultLimit;
}

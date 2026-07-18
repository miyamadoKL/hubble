// --- ファイル概要 ---
// このファイルはキーボードショートカットの「判定ロジック」だけを切り出したモジュール。
// KeyboardEvent（を模した KeyChord）とフォーカス位置（FocusContext）を受け取り、
// どのショートカットアクション（ShortcutAction）に該当するかを純粋関数 matchShortcut で判定する。
// DOM や React に依存しないため、useGlobalShortcuts.ts（実際にイベントを購読する側）から
// import されて使われるほか、単体テストもしやすい構造になっている。
// SHORTCUTS 配列は「ショートカット一覧ヘルプモーダル」の表示内容と、
// 実際のディスパッチ判定の両方が参照する唯一の正である。
//
// hotkey ライブラリへは置き換えない。現行実装が小さく、フォーカス位置に応じた
// run/format の切り替えのようなドメイン固有の判定が残るため、ライブラリ導入は
// 正味の削減にならない。

/** グローバルショートカットが引き起こしうる、シェルレベルのアクション種別。 */
export type ShortcutAction =
  | 'run' // Ctrl/Cmd+Enter でアクティブなセルを実行する
  | 'save' // Ctrl/Cmd+S で notebook を保存する
  // Workflow または Dashboard の編集中は、その画面の保存処理へ切り替える。
  | 'format' // Ctrl/Cmd+I または Ctrl+Shift+F で SQL を整形する
  | 'palette' // Ctrl/Cmd+K でコマンドパレットを開く
  | 'theme' // Ctrl+Alt+T でテーマを切り替える
  | 'presentation'; // Ctrl+Shift+P でプレゼンテーションモードを切り替える

/**
 * 現在フォーカスがどこにあるかを表す。'editor'（Monaco エディタ内）,
 * 'input'（テキスト入力欄など editor 以外のフォーム要素）, 'none'（それ以外＝どこにもフォーカスがない）
 * の3値で、run/format のようにフォーカス先によって挙動を変えるショートカットの判定に使う。
 */
export type FocusContext = 'editor' | 'input' | 'none';

/**
 * 実際の DOM の KeyboardEvent から、このモジュールが判定に必要とするプロパティだけを
 * 抜き出した軽量な型。DOM に依存しないためテストコードから任意のオブジェクトを渡して
 * matchShortcut を検証できる。
 */
export interface KeyChord {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * ショートカット一覧（ヘルプモーダル）の1行分の情報と、レジストリとしてのエントリを兼ねる型。
 * action はディスパッチ判定に使うキー、label は説明文、keys は画面表示用のキー表記。
 */
export interface ShortcutSpec {
  action: ShortcutAction;
  label: string;
  /** 画面に表示するキー表記（OS 非依存の表現。⌘ は Ctrl/Cmd として表示する）。 */
  keys: string[];
}

/**
 * ショートカットの正規リスト（プレゼンテーションモードの拡張を含む）。
 * ヘルプモーダルの表示内容そのものであり、実装が変わった場合はここも合わせて更新する必要がある。
 */
export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'run', label: 'Run the active cell', keys: ['Ctrl', '↵'] },
  { action: 'save', label: 'Save current document', keys: ['Ctrl', 'S'] },
  { action: 'format', label: 'Format SQL', keys: ['Ctrl', 'I'] },
  { action: 'format', label: 'Format SQL (alternate)', keys: ['Ctrl', 'Shift', 'F'] },
  { action: 'palette', label: 'Command palette', keys: ['Ctrl', 'K'] },
  { action: 'theme', label: 'Toggle light / dark theme', keys: ['Ctrl', 'Alt', 'T'] },
  { action: 'presentation', label: 'Toggle presentation mode', keys: ['Ctrl', 'Shift', 'P'] },
];

// isMod: Ctrl または Cmd（Mac の metaKey）のどちらかが押されているかを判定するヘルパー。
// ほとんどのショートカットは Ctrl/Cmd をプラットフォーム非依存の「修飾キー」として扱う。
const isMod = (e: KeyChord) => e.ctrlKey || e.metaKey;
// key: KeyboardEvent.key を小文字化して比較しやすくするヘルパー（大文字/小文字の揺れを吸収）。
const key = (e: KeyChord) => e.key.toLowerCase();

/**
 * キー入力（KeyChord）とフォーカス位置（FocusContext）から、対応するグローバルショートカット
 * アクションを判定する純粋関数。どのショートカットにも該当しない場合、または「今のフォーカス
 * 位置ではこのモジュールが処理すべきでない」場合は null を返す。
 *
 * フォーカス位置によって挙動が変わるのは run と format のみ:
 *   - run（実行）は Monaco エディタ自身のコマンドや変数入力欄が自前で処理するため、
 *     フォーカスがどこにもない（'none'）ときだけこの関数がグローバルに処理する。
 *   - format（SQL整形）は Ctrl+I の場合、エディタにフォーカスがあるときはエディタ自身が
 *     ローカルに処理するのでここでは扱わない。それ以外のフォーカスでは最後にフォーカス
 *     していたエディタに対して整形を実行する（呼び出し側 useGlobalShortcuts.ts が担当）。
 *   - save / palette / theme / presentation はフォーカス位置に関係なく常にグローバル。
 *
 * 戻り値の ShortcutAction は useGlobalShortcuts.ts の switch 文でディスパッチされる。
 */
export function matchShortcut(e: KeyChord, focus: FocusContext): ShortcutAction | null {
  const k = key(e);

  // コマンドパレット: Ctrl/Cmd+K（AltとShift は押されていないこと）。
  if (isMod(e) && !e.altKey && !e.shiftKey && k === 'k') return 'palette';

  // 保存: Ctrl/Cmd+S（AltとShift は押されていないこと）。
  if (isMod(e) && !e.altKey && !e.shiftKey && k === 's') return 'save';

  // テーマ切り替え: Ctrl+Alt+T。Cmd では発火させない（ブラウザの
  // 既存ショートカットとの衝突を避けるため）。
  if (e.ctrlKey && e.altKey && k === 't') return 'theme';

  // プレゼンテーションモード切り替え: Ctrl/Cmd+Shift+P。
  if (isMod(e) && e.shiftKey && k === 'p') return 'presentation';

  // SQL整形: Ctrl/Cmd+Shift+F はどのフォーカス位置でも有効。
  // Ctrl/Cmd+I はエディタにフォーカスがある場合のみ除外する（エディタ自身が Ctrl+I を
  // ローカルにバインドしているため、二重発火を避ける）。
  if (isMod(e) && e.shiftKey && !e.altKey && k === 'f') return 'format';
  if (isMod(e) && !e.shiftKey && !e.altKey && k === 'i' && focus !== 'editor') return 'format';

  // セル実行: フォーカスがどこにもない（'none'）ときのみ発火する。エディタや変数入力欄に
  // フォーカスがある場合は、それぞれが自前で Ctrl/Cmd+Enter を処理するのでここでは扱わない。
  if (isMod(e) && !e.altKey && !e.shiftKey && k === 'enter' && focus === 'none') return 'run';

  // どの条件にも一致しなければ、このモジュールが関知すべきショートカットではないので null。
  return null;
}

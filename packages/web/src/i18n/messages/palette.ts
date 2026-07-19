/**
 * i18n フェーズ 2c: コマンドパレット（`components/palette/CommandPalette.tsx`）専用の
 * 文言辞書。コマンド名、グループ見出し、検索欄のプレースホルダー、トースト文言を持つ。
 * キーボードショートカットの表示文字列（"Ctrl", "S" 等、Kbd コンポーネントへ渡す値）は
 * 対象外（スコープ外の指示どおり、そのまま維持する）。
 */
import { defineDictionary } from '../t';

export const paletteMessages = defineDictionary({
  // ---- コマンド一覧 ----
  saveNotebookAs: { ja: 'ノートブックに名前を付けて保存…', en: 'Save notebook as…' },
  openNotebookCommand: { ja: 'ノートブックを開く…', en: 'Open notebook…' },
  newMarkdownCellCommand: { ja: '新規 Markdown セル', en: 'New Markdown cell' },
  gotoDataBrowser: { ja: 'データブラウザへ移動', en: 'Go to Data browser' },
  gotoSavedQueries: { ja: '保存済みクエリへ移動', en: 'Go to Saved queries' },
  gotoHistory: { ja: '履歴へ移動', en: 'Go to History' },
  gotoNotebooks: { ja: 'ノートブックへ移動', en: 'Go to Notebooks' },
  switchToLightTheme: { ja: 'ライトテーマに切り替え', en: 'Switch to light theme' },
  switchToDarkTheme: { ja: 'ダークテーマに切り替え', en: 'Switch to dark theme' },
  exitPresentationMode: { ja: 'プレゼンテーションモードを終了', en: 'Exit presentation mode' },
  enterPresentationMode: { ja: 'プレゼンテーションモードを開始', en: 'Enter presentation mode' },

  // ---- グループ見出し ----
  groupQuery: { ja: 'クエリ', en: 'Query' },
  groupNotebook: { ja: 'ノートブック', en: 'Notebook' },
  groupNavigate: { ja: '移動', en: 'Navigate' },
  groupAppearance: { ja: '表示', en: 'Appearance' },
  groupHelp: { ja: 'ヘルプ', en: 'Help' },

  // ---- トースト ----
  createNotebookFirstBody: {
    ja: '先にノートブックを作成してください。',
    en: 'Create a notebook first.',
  },
  openFailedTitle: { ja: '開けませんでした', en: 'Open failed' },
  openFailedBody: {
    ja: 'そのノートブックを読み込めませんでした。',
    en: 'That notebook could not be loaded.',
  },

  // ---- パレットのUI要素 ----
  closeCommandPaletteAria: { ja: 'コマンドパレットを閉じる', en: 'Close command palette' },
  openBadge: { ja: '開く', en: 'Open' },
  typeCommandPlaceholder: { ja: 'コマンドを入力…', en: 'Type a command…' },
  noMatchingCommands: { ja: '一致するコマンドがありません', en: 'No matching commands' },
  couldntLoadNotebooks: { ja: 'ノートブックを読み込めませんでした', en: "Couldn't load notebooks" },
} as const);

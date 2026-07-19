/**
 * AI アシスタントパネル（AiPanel）で使う文言の辞書。
 * ここに置くのはパネルの見出し、タスクボタン、入力欄のプレースホルダー、
 * 空状態やローディング表示、トーストのタイトル/本文といった UI の地の文のみ。
 * AI モデルが生成した応答本文（ストリーミングされる Markdown）や、サーバーが
 * 返すエラー本文はフェーズ 1 の方針により翻訳対象外（そのまま表示する）。
 */
import { defineDictionary } from '../t';

export const aiMessages = defineDictionary({
  // パネルヘッダー。
  panelHeading: { ja: 'AI アシスタント', en: 'AI assistant' },
  panelAriaLabel: { ja: 'AI アシスタントパネル', en: 'AI assistant panel' },
  closePanel: { ja: 'AI パネルを閉じる', en: 'Close AI panel' },
  resizeHandleLabel: { ja: 'AI パネルの幅を変更', en: 'Resize AI panel' },

  // タスクボタン（ラベルとホバー時の説明）。
  taskExplainLabel: { ja: '説明', en: 'Explain' },
  taskExplainHint: {
    ja: '選択した SQL（または全文）を説明する',
    en: 'Explain the selected SQL (or the whole cell)',
  },
  taskFixLabel: { ja: 'エラー修正', en: 'Fix error' },
  taskFixHint: {
    ja: '直近のエラーから修正案を出す',
    en: 'Propose a fix based on the most recent error',
  },
  taskDraftLabel: { ja: '下書き', en: 'Draft' },
  taskDraftHint: {
    ja: '指示とテーブル情報から SQL を下書きする',
    en: 'Draft SQL from an instruction and table context',
  },
  taskRewriteLabel: { ja: '書き換え', en: 'Rewrite' },
  taskRewriteHint: {
    ja: '指示に沿って SQL を書き換える',
    en: 'Rewrite the SQL according to an instruction',
  },

  // 入力欄のプレースホルダー。
  instructionPlaceholder: {
    ja: '指示（下書きでは必須、書き換えでは任意）…',
    en: 'Instruction (required for Draft, optional for Rewrite)…',
  },
  tablesPlaceholder: {
    ja: '文脈のテーブル: catalog.schema.table, …',
    en: 'Context tables: catalog.schema.table, …',
  },

  // 応答表示エリアの空状態 / ローディング表示。
  emptyStateText: {
    ja: 'SQL セルにフォーカスしてからタスクを選んでください。アシスタントは SQL を提案するだけで、実行は常に通常のエディター操作を経由します。',
    en: 'Focus a SQL cell, then pick a task. The assistant only proposes SQL; execution always goes through the normal editor flow.',
  },
  waitingForModel: { ja: 'モデルの応答を待っています…', en: 'Waiting for the model…' },

  // フッターのボタン。
  stopButton: { ja: '停止', en: 'Stop' },
  reviewAndApplyButton: { ja: 'レビューして適用', en: 'Review & apply' },

  // トースト（共通タイトル）。
  toastTitle: { ja: 'AI アシスタント', en: 'AI assistant' },
  toastFocusSqlCell: {
    ja: '内容のある SQL セルにフォーカスしてください。',
    en: 'Focus a SQL cell with content first.',
  },
  toastNoRecentError: {
    ja: 'フォーカス中のセルに直近のエラーがありません。',
    en: 'The focused cell has no recent error to fix.',
  },
  toastWriteInstruction: {
    ja: '下書きの指示を入力してください。',
    en: 'Write an instruction for the draft first.',
  },
  toastNoDatasource: { ja: 'データソースが選択されていません。', en: 'No datasource selected.' },
  toastFailedResolveTables: {
    ja: '文脈テーブルの解決に失敗しました: {message}',
    en: 'Failed to resolve context tables: {message}',
  },
  invalidTableName: {
    ja: '不正なテーブル名です: {name}（catalog.schema.table 形式が必要）',
    en: 'Invalid table name: {name} (expected catalog.schema.table)',
  },
  toastSqlApplied: {
    ja: '提案された SQL を適用しました。Ctrl/Cmd+Z で取り消せます。',
    en: 'Proposed SQL applied. Undo with Ctrl/Cmd+Z.',
  },
  toastTargetChanged: {
    ja: '待機中に対象が変わりました。SQL は手動でコピーしてください。',
    en: 'The target changed while waiting. Copy the SQL manually.',
  },
} as const);

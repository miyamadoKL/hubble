/**
 * Schedule / Alert パネル群で共通利用する汎用文言の辞書。
 * ボタンラベル、相対時刻表示、検索結果なし、削除確認、失敗トーストなど、
 * 両パネルでほぼ同じ言い回しになる文字列だけをここに集約する。
 * パネル固有の文言（フィールドラベル、プレースホルダー等）は各領域の辞書
 * （`schedule.ts` / `alert.ts` / `scheduleBuilder.ts`）に置く。
 */
import { defineDictionary } from '../t';

export const commonMessages = defineDictionary({
  cancel: { ja: 'キャンセル', en: 'Cancel' },
  edit: { ja: '編集', en: 'Edit' },
  loading: { ja: '読み込み中…', en: 'Loading…' },
  noMatches: { ja: '一致する項目がありません', en: 'No matches' },
  tryDifferentSearchTerm: {
    ja: '検索語を変えてお試しください。',
    en: 'Try a different search term.',
  },
  couldNotReachServer: {
    ja: 'サーバーに接続できませんでした。',
    en: 'Could not reach the server.',
  },
  serverDidntRespond: {
    ja: 'サーバーから応答がありませんでした。',
    en: "The server didn't respond.",
  },

  // 「次回実行/評価予定」の相対時刻表示。schedule/alert 両パネルの行で共有する。
  dueNow: { ja: 'まもなく実行', en: 'due now' },
  relativeLessThanOneMinute: { ja: '1 分未満', en: 'in <1m' },
  relativeMinutes: { ja: '{n} 分後', en: 'in {n}m' },
  relativeHours: { ja: '{n} 時間後', en: 'in {n}h' },
  relativeDays: { ja: '{n} 日後', en: 'in {n}d' },
  unknown: { ja: '—', en: '—' },

  // 過去方向の相対時刻表示（utils/format.ts の formatRelativeTime）。実行履歴一覧など
  // 「n 分前」のような表示に使う。上の relativeXxx（未来方向、「n 分後」）とは向きが
  // 逆なので別エントリにしている。
  agoJustNow: { ja: 'たった今', en: 'just now' },
  agoMinutes: { ja: '{n} 分前', en: '{n}m ago' },
  agoHours: { ja: '{n} 時間前', en: '{n}h ago' },
  agoDays: { ja: '{n} 日前', en: '{n}d ago' },

  // 削除確認モーダルと削除トーストの共通形。タイトルは対象種別ごとに異なる文言
  // （「スケジュールを削除しますか?」等）になるため各領域の辞書側で個別に持つ。
  deleteConfirmDescription: {
    ja: '「{name}」は完全に削除されます。',
    en: '“{name}” will be permanently removed.',
  },
  delete: { ja: '削除', en: 'Delete' },
  deleted: { ja: '削除しました', en: 'Deleted' },
  deleteFailed: { ja: '削除に失敗しました', en: 'Delete failed' },
  updateFailed: { ja: '更新に失敗しました', en: 'Update failed' },

  // 言語切替トグル（TopBar）。
  switchToJapanese: { ja: '日本語に切り替え', en: 'Switch to Japanese' },
  switchToEnglish: { ja: '英語に切り替え', en: 'Switch to English' },
} as const);

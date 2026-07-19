/**
 * Alert 領域（`AlertsPanel.tsx` / `AlertFormModal.tsx`）専用の文言辞書。
 * 両パネルで共有する汎用文言（Cancel、相対時刻表示等）は `messages/common.ts` に、
 * スケジュールビルダー部分は `messages/scheduleBuilder.ts` にある。
 */
import { defineDictionary } from '../t';

export const alertMessages = defineDictionary({
  // ---- AlertsPanel ----
  muted: { ja: 'ミュート中', en: 'Muted' },
  nextEvalPrefix: { ja: '次回 {label}', en: 'next {label}' },
  // 「次回評価予定」が今すぐ到来している場合の表示。common.dueNow はスケジュールの
  // 「実行」を指す言い回しなので、Alert の「評価」の意味に合わせて別エントリにする
  // （レビュー指摘: 意味の異なる訳の使い回しを解消）。
  evalDueNow: { ja: 'まもなく評価', en: 'due now' },
  unmuteAlert: { ja: 'ミュート解除', en: 'Unmute alert' },
  muteAlert: { ja: 'ミュート', en: 'Mute alert' },
  evalNow: { ja: '今すぐ評価', en: 'Eval now' },
  evaluating: { ja: '評価中…', en: 'Evaluating…' },
  deleteAlertAria: { ja: 'アラートを削除', en: 'Delete alert' },
  deleteAlertTitle: { ja: 'アラートを削除しますか?', en: 'Delete alert?' },
  newAlert: { ja: '新規アラート', en: 'New alert' },
  noAlerts: { ja: 'アラートがありません', en: 'No alerts' },
  saveQueryFirstHint: {
    ja: 'まずクエリを保存してから、アラートを作成してください。',
    en: 'Save a query first, then create an alert.',
  },
  createAlertHint: {
    ja: 'クエリ結果を監視するアラートを作成しましょう。',
    en: 'Create an alert to monitor query results.',
  },
  couldntLoadAlerts: { ja: 'アラートを読み込めませんでした', en: "Couldn't load alerts" },

  // Alert の実行時状態（AlertState）の表示ラベル。契約値（ok/triggered/unknown）
  // 自体は変更せず、AlertStateBadge の表示だけを翻訳する。
  stateOk: { ja: 'OK', en: 'OK' },
  stateTriggered: { ja: '発火中', en: 'Triggered' },
  stateUnknown: { ja: '不明', en: 'Unknown' },

  // selector（結果行から監視値を取り出す方法）の表示ラベル。契約値
  // （first/max/min）自体は select の value としてそのまま送信し、画面表示のみ翻訳する。
  selectorFirst: { ja: '先頭行', en: 'first' },
  selectorMax: { ja: '最大値', en: 'max' },
  selectorMin: { ja: '最小値', en: 'min' },

  // トースト。
  notificationSent: { ja: '通知を送信しました', en: 'Notification sent' },
  evaluationCompleteTitle: { ja: '評価が完了しました', en: 'Evaluation complete' },
  evalStateBody: { ja: '状態: {state}', en: 'State: {state}' },
  alreadyEvaluatingTitle: { ja: '評価中です', en: 'Already evaluating' },
  alreadyEvaluatingBody: {
    ja: 'このアラートは既に評価中です。',
    en: 'This alert is being evaluated.',
  },
  evaluationFailedTitle: { ja: '評価に失敗しました', en: 'Evaluation failed' },
  evaluationFailedBody: {
    ja: 'アラートを評価できませんでした。',
    en: 'Could not evaluate the alert.',
  },
  alertCreatedTitle: { ja: 'アラートを作成しました', en: 'Alert created' },
  alertCreatedBody: { ja: '「{name}」の準備ができました。', en: '“{name}” is ready.' },
  alertUpdatedTitle: { ja: 'アラートを更新しました', en: 'Alert updated' },
  alertUpdatedBody: { ja: '「{name}」を保存しました。', en: '“{name}” saved.' },
  createFailedTitle: { ja: '作成に失敗しました', en: 'Create failed' },
  alertRemoved: { ja: 'アラートを削除しました。', en: 'Alert removed.' },

  // ---- AlertFormModal ----
  editAlert: { ja: 'アラートを編集', en: 'Edit alert' },
  newAlertTitle: { ja: '新規アラート', en: 'New alert' },
  save: { ja: '保存', en: 'Save' },
  saving: { ja: '保存中…', en: 'Saving…' },
  nameLabel: { ja: '名前', en: 'Name' },
  savedQueryLabel: { ja: '保存済みクエリ', en: 'Saved query' },
  columnLabel: { ja: '列', en: 'Column' },
  operatorLabel: { ja: '演算子', en: 'Operator' },
  thresholdLabel: { ja: 'しきい値', en: 'Threshold' },
  selectorLabel: { ja: 'セレクター', en: 'Selector' },
  // 「rearm」は triggered 状態が続く間に何秒おきに再通知するかの間隔であり
  // （0 は再通知しない、1 は毎回）、「再アーム」という直訳では意味が伝わらない
  // （レビュー指摘）ため「再通知間隔」とする。en は既存表記を維持する。
  rearmSecondsLabel: { ja: '再通知間隔（秒）', en: 'Rearm (seconds)' },
  scheduleLabel: { ja: 'スケジュール', en: 'Schedule' },
  mutedCheckbox: { ja: 'ミュート（通知しない）', en: 'Muted (no notifications)' },
  notificationsLegend: { ja: '通知', en: 'Notifications' },
  slackServerWebhook: { ja: 'Slack（サーバー webhook）', en: 'Slack (server webhook)' },
  emailLabel: { ja: 'メール', en: 'Email' },
  webhookLabel: { ja: 'Webhook', en: 'Webhook' },
  emailPlaceholder: { ja: 'ops@example.com', en: 'ops@example.com' },
  webhookPlaceholder: { ja: 'https://example.com/hook', en: 'https://example.com/hook' },
} as const);

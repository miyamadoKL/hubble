/**
 * i18n フェーズ 2c: パネル系コンポーネント（History / SavedQueries / Operations /
 * NotebookList）で使う文言辞書。
 * これらのパネルは互いに近い操作（Insert / New cell / 削除確認など）を持つため、
 * パネルをまたいで共有する語（Insert、Re-run 等）もこのファイルにまとめて置く
 * （Schedule/Alert 領域が `commonMessages` を共有するのと同じ考え方だが、
 * 本バッチでは common.ts 自体は変更しない方針のため専用の共有ブロックとして持つ）。
 * 汎用語（Cancel、Delete、Loading 等）は既存の `messages/common.ts` を再利用する。
 */
import { defineDictionary } from '../t';

export const panelsMessages = defineDictionary({
  // ---- パネル間で共有するボタン/トースト文言 ----
  // (HistoryPanel と SavedQueriesPanel の両方が Insert / New cell を持つ)
  insert: { ja: '挿入', en: 'Insert' },
  // ボタンの可視ラベル（"New cell"）と、追加成功時のトーストタイトル（"New SQL cell"）は
  // 元実装から表記が異なるため別エントリにする。
  newCellButton: { ja: '新規セル', en: 'New cell' },
  newSqlCellToast: { ja: '新規 SQL セル', en: 'New SQL cell' },
  share: { ja: '共有', en: 'Share' },

  // ---- HistoryPanel ----
  // state フィルタチップの表示ラベル。契約値（HistoryFilter/QueryState）自体は
  // フィルタリング用の id としてそのまま使い、表示だけをこのテーブル経由で翻訳する
  // (alertFormat.ts の selector/state ラベル変換と同じパターン)。
  filterAll: { ja: 'すべて', en: 'All' },
  filterFinished: { ja: '完了', en: 'Finished' },
  filterFailed: { ja: '失敗', en: 'Failed' },
  filterCanceled: { ja: 'キャンセル済み', en: 'Canceled' },
  filterRunning: { ja: '実行中', en: 'Running' },
  // HistoryFilter は契約側の QueryState を含み 'queued' も理論上取りうるが、FILTERS
  // チップには表示していない（既存 UI の仕様）。Record<HistoryFilter, ...> の型網羅性を
  // 満たすためだけにここで定義する。
  filterQueued: { ja: 'キュー待ち', en: 'Queued' },

  // StateBadge (common/StateBadge.tsx) の表示ラベル用。QueryState の契約値
  // (queued/running/finished/failed/canceled) を StatusBadge の label へ渡す前に
  // 翻訳する (alertFormat.ts の AlertState ラベル変換と同じパターン。詳細は
  // queryStateFormat.ts を参照)。
  queryStateQueued: { ja: 'キュー待ち', en: 'QUEUED' },
  queryStateRunning: { ja: '実行中', en: 'RUNNING' },
  queryStateFinished: { ja: '完了', en: 'FINISHED' },
  queryStateFailed: { ja: '失敗', en: 'FAILED' },
  queryStateCanceled: { ja: 'キャンセル済み', en: 'CANCELED' },

  reRun: { ja: '再実行', en: 'Re-run' },
  openResult: { ja: '結果を開く', en: 'Open result' },
  reRunningQueryToast: { ja: 'クエリを再実行しています', en: 'Re-running query' },
  openedSavedResultToast: { ja: '保存済みの結果を開きました', en: 'Opened saved result' },
  savedResultUnavailableTitle: {
    ja: '保存済みの結果を利用できません',
    en: 'Saved result unavailable',
  },
  savedResultUnavailableBody: {
    ja: '保存されたクエリ結果を読み込めませんでした。',
    en: 'The stored query result could not be loaded.',
  },
  couldntLoadHistory: { ja: '履歴を読み込めませんでした', en: "Couldn't load history" },
  noHistoryYet: { ja: '履歴がまだありません', en: 'No history yet' },
  noMatchingHistory: { ja: '一致する履歴がありません', en: 'No matching history' },
  historyRecordedHint: {
    ja: '実行したクエリはここに自動で記録されます。',
    en: 'Executed queries are recorded here automatically.',
  },
  noQueriesWithStateHint: {
    ja: 'この状態のクエリはありません。',
    en: 'No queries with this state.',
  },
  loadMoreButton: {
    ja: 'もっと見る（{shown} / {total} 件）',
    en: 'Load more ({shown} of {total})',
  },
  rowsCount: { ja: '{n} 行', en: '{n} rows' },
  queryIdLabel: { ja: 'クエリ', en: 'query' },
  rowsLabel: { ja: '行数', en: 'rows' },
  elapsedLabel: { ja: '経過時間', en: 'elapsed' },

  // ---- SavedQueriesPanel ----
  favorite: { ja: 'お気に入り登録', en: 'Favorite' },
  unfavorite: { ja: 'お気に入り解除', en: 'Unfavorite' },
  newSqlCellAddedBody: { ja: '「{name}」を追加しました。', en: '“{name}” added.' },
  deleteSavedQueryTitle: { ja: '保存済みクエリを削除しますか?', en: 'Delete saved query?' },
  savedQueryRemovedBody: { ja: '保存済みクエリを削除しました。', en: 'Saved query removed.' },
  noSavedQueries: { ja: '保存済みクエリがありません', en: 'No saved queries' },
  saveQueryFromCellHint: {
    ja: 'セルからクエリを保存すると、ここに表示されます。',
    en: 'Save a query from a cell to find it here.',
  },
  couldntLoadSavedQueries: {
    ja: '保存済みクエリを読み込めませんでした',
    en: "Couldn't load saved queries",
  },

  // ---- OperationsPanel ----
  killButton: { ja: '強制終了', en: 'Kill' },
  killQueryByAria: { ja: '{owner} のクエリを強制終了', en: 'Kill query by {owner}' },
  couldNotLoadQueries: { ja: 'クエリを読み込めませんでした', en: 'Could not load queries' },
  checkConnectionHint: {
    ja: '接続を確認して、もう一度お試しください。',
    en: 'Check your connection and try again.',
  },
  noActiveQueries: { ja: '実行中のクエリはありません', en: 'No active queries' },
  allUsersQueriesHint: {
    ja: '全ユーザーの実行中クエリがここに表示されます。',
    en: 'Running queries from all users will appear here.',
  },
  killQueryTitle: { ja: 'クエリを強制終了しますか?', en: 'Kill query?' },
  killQueryDescription: { ja: 'オーナー: {owner}\n{statement}', en: 'Owner: {owner}\n{statement}' },
  queryKilledTitle: { ja: 'クエリを強制終了しました', en: 'Query killed' },
  queryKilledBody: { ja: '{owner} のクエリを停止しました。', en: "Stopped {owner}'s query." },
  killFailedTitle: { ja: '強制終了に失敗しました', en: 'Kill failed' },
  killFailedBody: { ja: 'クエリを停止できませんでした。', en: 'Could not stop the query.' },

  // ---- NotebookListPanel ----
  // "No notebooks" はコマンドパレットのノートブック検索サブモードでも同じ文言が
  // 必要になるが、common.ts は変更しない方針のためここでは重複させている
  // (共通化候補: 最終報告を参照)。
  noNotebooks: { ja: 'ノートブックがありません', en: 'No notebooks' },
  createNotebookHint: {
    ja: 'ノートブックを作成して SQL セルの作成を始めましょう。',
    en: 'Create a notebook to start composing SQL cells.',
  },
} as const);

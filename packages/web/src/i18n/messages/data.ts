/**
 * データブラウザ（SchemaTree / TableDetailPopover）で使う UI 文言の辞書。
 * catalog → schema → table → column のツリー表示、テーブル詳細ポップオーバーの
 * 見出し、空状態、エラー表示、トースト通知など、画面に固定で出る文字列だけを持つ。
 * catalog 名、schema 名、table 名、column 名、型名（varchar 等）といった DB 由来の
 * メタデータ値はここでは扱わない（API から取得した値をそのまま描画するため翻訳対象外）。
 */
import { defineDictionary } from '../t';

export const dataMessages = defineDictionary({
  // ---- SchemaTree: ツリー行の状態表示 ----------------------------------------
  retry: { ja: '再試行', en: 'retry' },
  failed: { ja: '失敗', en: 'Failed' },
  empty: { ja: '空', en: 'Empty' },
  noColumns: { ja: 'カラムなし', en: 'No columns' },
  noTables: { ja: 'テーブルなし', en: 'No tables' },
  noSchemas: { ja: 'スキーマなし', en: 'No schemas' },
  noCatalogs: { ja: 'カタログなし', en: 'No catalogs' },

  // アイコンのみの「詳細」ボタン。可視ラベルが無いため aria-label 自体が唯一の
  // アクセシブルネームになる（テーブル名 {table} は DB 由来のメタデータ値なので
  // 翻訳せずそのまま埋め込む）。
  detailsForTable: { ja: '{table} の詳細', en: 'Details for {table}' },

  // ヘッダーの更新ボタン（アイコンのみ）。
  refreshMetadataLabel: { ja: 'メタデータを更新', en: 'Refresh metadata' },
  metadataRefreshedTitle: { ja: 'メタデータを更新しました', en: 'Metadata refreshed' },
  metadataRefreshedDescription: {
    ja: '{datasourceId} のスキーマキャッシュを再読み込みしました。',
    en: 'Datasource {datasourceId} schema cache reloaded.',
  },
  refreshFailedTitle: { ja: '更新に失敗しました', en: 'Refresh failed' },

  // ヘッダーの catalog 件数表示。
  catalogsCount: { ja: 'カタログ {count} 件', en: '{count} catalogs' },
  schemasLabel: { ja: 'スキーマ', en: 'schemas' },

  // ---- TableDetailPopover ------------------------------------------------------
  tableDetailsDialogLabel: { ja: '{name} の詳細', en: '{name} details' },
  closeDetailsLabel: { ja: '詳細を閉じる', en: 'Close details' },
  close: { ja: '閉じる', en: 'Close' },
  viewBadge: { ja: 'ビュー', en: 'view' },
  tableBadge: { ja: 'テーブル', en: 'table' },
  selectTemplateButton: { ja: 'SELECT テンプレート', en: 'SELECT template' },
  newSqlCellToastTitle: { ja: '新規 SQL セル', en: 'New SQL cell' },
  newSqlCellToastDescription: {
    ja: '{name} 用の SELECT テンプレートを追加しました。',
    en: 'SELECT template for {name} added.',
  },
  columnsHeading: { ja: 'カラム', en: 'Columns' },
  loadingColumns: { ja: 'カラムを読み込み中…', en: 'Loading columns…' },
  failedToLoadColumns: { ja: 'カラムの読み込みに失敗しました。', en: 'Failed to load columns.' },
  // 区切り記号規約: 日本語文中では中黒/中点による並列を使わない。英語側は
  // EstimateStrip 等、既存の UI 全体で使われている " · " 区切りの慣習に合わせて
  // そのまま維持する（言語非依存の記号としての既存用法であり、変更しない）。
  sampleHeading: { ja: 'サンプル（10 行）', en: 'Sample · 10 rows' },
  loadingSample: { ja: 'サンプルを読み込み中…', en: 'Loading sample…' },
  failedToLoadSample: {
    ja: 'サンプル行の読み込みに失敗しました。',
    en: 'Failed to load sample rows.',
  },
  noRows: { ja: '行がありません。', en: 'No rows.' },
} as const);

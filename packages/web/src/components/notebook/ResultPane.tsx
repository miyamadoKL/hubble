// ResultPane コンポーネント
// SQLセルの実行結果を表示するパネル。Grid（表形式）/ Chart（グラフ）/
// Explain（実行計画）/ Details（実行メタ情報）の4タブ構成で、エラー発生時は
// 上部にエラーバナーも表示する。表示内容は execution ストアの CellExecution
// レコードによって完全に駆動される（design.md §6 参照）。
import { useEffect, useState } from 'react';
import {
  BarChart3,
  Check,
  Clipboard,
  Download,
  FileText,
  Info,
  Table2,
  TriangleAlert,
} from 'lucide-react';
import { Tabs, type TabItem } from '../common/Tabs';
import { IconButton } from '../common/IconButton';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { Dropdown } from '../common/Dropdown';
import { ResultGrid } from './ResultGrid';
import { ChartPanel } from './ChartPanel';
import { ErrorPanel } from './ErrorPanel';
import { formatBytes, formatDuration, formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';
import {
  copyResultToClipboard,
  downloadCsvUrl,
  isCellRunning,
  type CellExecution,
  type DownloadFormat,
} from '../../execution';

/**
 * Live result pane with per-cell tabs (design.md §6: Grid / Chart / Explain /
 * Details + Error). Driven entirely by the cell's `CellExecution` record from
 * the execution store. EXPLAIN runs a separate query through `onExplain` and
 * shows its plan text here.
 */

// 結果ペインで切り替え可能なタブの種類。
type ResultTab = 'grid' | 'chart' | 'explain' | 'details';

/** ResultPane の props */
interface ResultPaneProps {
  /** The notebook cell id (keys the per-cell chart config). */
  // ノートブックのセルID（セルごとのチャート設定を紐付けるキーとして使う）。
  cellId: string;
  // このセルの実行状態全体（列、行、統計、エラー、状態など）を持つレコード。
  cell: CellExecution;
  /** Plain plan text from an EXPLAIN run (single-column rows joined by newline). */
  // EXPLAIN実行結果のプレーンテキスト（単一列の各行を改行で連結したもの）。
  explainText?: string;
  // EXPLAINクエリが現在実行中かどうか。
  explainRunning?: boolean;
  // EXPLAINタブが最初に開かれたとき（または再実行ボタン押下時）に呼ばれるハンドラー。
  onExplain?: () => void;
}

/** DetailRow（Detailsタブの1行）の props */
interface DetailRowProps {
  // 項目名（例: "Query id" など）
  label: string;
  // 表示する値
  value: string;
  // 等幅フォント + 数値整列で表示するかどうか（デフォルトtrue）
  mono?: boolean;
}

/** Detailsタブ内で「ラベル: 値」を1行として表示する小さな行コンポーネント。 */
function DetailRow({ label, value, mono = true }: DetailRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-subtle py-1.5">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className={cn('text-xs text-ink-base', mono && 'font-mono tabular-nums')}>{value}</span>
    </div>
  );
}

/**
 * SQLセルの実行結果を表示するメインコンポーネント。
 * Grid / Chart / Explain / Details の4タブを持ち、エラーがあれば
 * ErrorPanel を上部に表示する。EXPLAINタブは初回オープン時に自動的に
 * onExplain を呼び出して実行計画を取得する。
 */
export function ResultPane({ cellId, cell, explainText, explainRunning, onExplain }: ResultPaneProps) {
  // 現在選択中のタブ（初期値は Grid）。
  const [tab, setTab] = useState<ResultTab>('grid');
  // 「結果をコピー」ボタンの一時的な成功表示（コピー完了アイコンを1.5秒だけ出す）用フラグ。
  const [copied, setCopied] = useState(false);
  // このセルの実行がエラーになっているかどうか。
  const hasError = Boolean(cell.error);

  // タブバーに表示するタブの定義（id、ラベル、アイコン）。
  const TABS: TabItem<ResultTab>[] = [
    { id: 'grid', label: 'Grid', icon: Table2 },
    { id: 'chart', label: 'Chart', icon: BarChart3 },
    { id: 'explain', label: 'Explain', icon: FileText },
    { id: 'details', label: 'Details', icon: Info },
  ];

  // Trigger the EXPLAIN run the first time its tab is opened (or re-run via btn).
  // Explainタブが選択され、かつまだ実行計画テキストを取得しておらず実行中でもなければ、
  // EXPLAINクエリを自動的にトリガーする（初回タブオープン時のみ発火させたいので、
  // 依存配列はあえて tab のみにしている＝exhaustive-deps を無効化）。
  useEffect(() => {
    if (tab === 'explain' && explainText === undefined && !explainRunning) {
      onExplain?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // 「結果をコピー」ボタンのクリックハンドラー。TSV+HTML形式でクリップボードにコピーし、
  // 成功したら1.5秒間だけチェックアイコンを表示する。クリップボード拒否時は何もしない。
  const onCopy = async () => {
    try {
      await copyResultToClipboard(cell.columns, cell.rows);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — no-op */
    }
  };

  // Detailsタブで使う統計情報を取り出しておく。
  const stats = cell.stats;
  // このセルが現在実行中（queued/running）かどうか。
  const running = isCellRunning(cell);

  return (
    <div className="animate-[slideUp_150ms_ease-out]" data-testid="result-pane">
      {/* Error banner takes priority above the tabs. */}
      {/* エラーバナー: タブより優先して最上部に表示する。 */}
      {hasError && cell.error && <ErrorPanel error={cell.error} />}

      {/* タブ切り替えバー + 右側のアクションボタン群（コピー・CSVダウンロード）。 */}
      <div className="flex items-center justify-between gap-2 pr-2">
        <Tabs items={TABS} value={tab} onChange={setTab} className="flex-1" />
        <div className="flex items-center gap-0.5">
          <IconButton
            icon={copied ? Check : Clipboard}
            label={copied ? 'Copied' : 'Copy as TSV + HTML'}
            size="sm"
            disabled={cell.rows.length === 0}
            onClick={onCopy}
          />
          <CsvDownload queryId={cell.queryId} disabled={!cell.queryId} />
        </div>
      </div>

      {/* Gridタブ: 列が無く実行中でもなければ空状態、それ以外は結果テーブルを表示する。 */}
      {tab === 'grid' &&
        (cell.columns.length === 0 && !running ? (
          // 結果が無いケース。エラー起因か、単に0件だったかでメッセージを出し分ける。
          <div className="bg-surface-sunken">
            <EmptyState
              icon={Table2}
              title={hasError ? 'No result' : 'No rows'}
              description={
                hasError
                  ? 'The statement failed — see the error above.'
                  : 'This statement returned no rows.'
              }
              compact
            />
          </div>
        ) : (
          <>
            {/* 実際の結果テーブル本体。 */}
            <ResultGrid columns={cell.columns} rows={cell.rows} />
            <div className="flex items-center justify-between border-t border-border-base bg-surface-base px-3 py-1.5">
              <span className="font-mono text-2xs text-ink-subtle">
                {formatInt(cell.rowCount)} rows · {cell.columns.length} columns
              </span>
              {/* 行数上限で結果が打ち切られている場合の警告表示。 */}
              {cell.truncated && (
                <span className="inline-flex items-center gap-1 text-2xs font-medium text-warning">
                  <TriangleAlert size={11} strokeWidth={2} />
                  result truncated at the row cap
                </span>
              )}
            </div>
          </>
        ))}

      {/* Chartタブ: 現在の結果列と行をグラフ描画パネルに渡す。 */}
      {tab === 'chart' && <ChartPanel cellId={cellId} columns={cell.columns} rows={cell.rows} />}

      {/* Explainタブ: EXPLAIN実行結果のプレーンテキストを表示する（下記 ExplainView 参照）。 */}
      {tab === 'explain' && (
        <ExplainView text={explainText} running={explainRunning} onRun={onExplain} />
      )}

      {/* Detailsタブ: クエリID、実行時刻、統計情報などのメタ情報を一覧表示する。 */}
      {tab === 'details' && (
        <div className="bg-surface-sunken px-4 py-2">
          <DetailRow label="Query id" value={cell.queryId || '—'} />
          <DetailRow label="Trino query id" value={cell.trinoQueryId ?? '—'} />
          <DetailRow
            label="Submitted"
            value={cell.startedAt ? new Date(cell.startedAt).toLocaleString() : '—'}
            mono={false}
          />
          <DetailRow
            label="Finished"
            value={cell.finishedAt ? new Date(cell.finishedAt).toLocaleString() : '—'}
            mono={false}
          />
          <DetailRow label="State" value={cell.state} mono={false} />
          <DetailRow label="Elapsed" value={formatDuration(stats?.elapsedTimeMillis ?? 0)} />
          <DetailRow label="Wall time" value={formatDuration(stats?.wallTimeMillis ?? 0)} />
          <DetailRow label="Processed rows" value={formatInt(stats?.processedRows ?? 0)} />
          <DetailRow label="Processed bytes" value={formatBytes(stats?.processedBytes ?? 0)} />
          <DetailRow label="Peak memory" value={formatBytes(stats?.peakMemoryBytes ?? 0)} />
          <DetailRow
            label="Splits"
            value={`${formatInt(stats?.completedSplits ?? 0)} / ${formatInt(stats?.totalSplits ?? 0)}`}
          />
          <DetailRow label="Worker nodes" value={stats?.nodes ? formatInt(stats.nodes) : '—'} />
        </div>
      )}
    </div>
  );
}

/**
 * EXPLAINタブの中身を出し分けるサブコンポーネント。
 * running中は「実行中」メッセージ、text未取得なら実行を促す空状態、
 * それ以外はプランテキストを整形して表示する。
 */
function ExplainView({
  text,
  running,
  onRun,
}: {
  // EXPLAIN結果のプレーンテキスト（未取得ならundefined）
  text?: string;
  // EXPLAINクエリが実行中かどうか
  running?: boolean;
  // 「Run EXPLAIN」ボタン押下時のハンドラー
  onRun?: () => void;
}) {
  // 実行中は専用のローディングメッセージを表示する。
  if (running) {
    return (
      <div className="bg-surface-sunken px-4 py-6 text-center font-mono text-xs text-ink-muted">
        Running EXPLAIN…
      </div>
    );
  }
  // まだ一度もEXPLAINを実行していない（text未定義）場合は、実行を促す空状態を表示する。
  if (text === undefined) {
    return (
      <div className="bg-surface-sunken">
        <EmptyState
          icon={FileText}
          title="Explain plan"
          description="Run EXPLAIN on the current statement to see its distributed plan."
          compact
          action={
            onRun ? (
              <Button size="sm" icon={FileText} onClick={onRun}>
                Run EXPLAIN
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  // 実行計画のテキストをそのまま整形済みテキストとして表示する（空文字なら "(empty plan)"）。
  return (
    <pre className="max-h-96 overflow-auto bg-surface-sunken px-4 py-3 font-mono text-xs leading-relaxed text-ink-base">
      {text || '(empty plan)'}
    </pre>
  );
}

/** CSV download as plain `a[href]` so the server streams it (no buffering). */
/**
 * CSVダウンロードボタン + フォーマット切り替えドロップダウン。
 * サーバー側でストリーミング配信させるため、あえて素の `a[href]` タグを使い、
 * fetch＋blob化などのバッファリングを避けている。
 */
function CsvDownload({ queryId, disabled }: { queryId: string; disabled: boolean }) {
  // 現在選択中のダウンロード形式（zip圧縮 or 生CSV）。
  const [format, setFormat] = useState<DownloadFormat>('zip');
  // ダウンロード先URL。disabled中はhrefを設定せずクリックを実質無効化する。
  const href = disabled ? undefined : downloadCsvUrl(queryId, format);
  // ダウンロードファイルの拡張子をフォーマットに応じて決定する。
  const ext = format === 'zip' ? 'zip' : 'csv';
  return (
    <div className="flex items-center">
      <a
        href={href}
        download={disabled ? undefined : `result-${queryId}.${ext}`}
        aria-disabled={disabled}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-l-md border border-border-base px-2 text-2xs font-medium',
          disabled
            ? 'pointer-events-none text-ink-subtle opacity-40'
            : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
        )}
      >
        <Download size={13} strokeWidth={1.75} />
        {format === 'zip' ? 'CSV (zip)' : 'CSV'}
      </a>
      <Dropdown<DownloadFormat>
        value={format}
        onChange={setFormat}
        options={[
          { value: 'zip', label: 'Zipped .zip' },
          { value: 'csv', label: 'Plain .csv' },
        ]}
        ariaLabel="Download format"
        align="end"
        className="h-6 rounded-l-none rounded-r-md border-l-0 text-2xs"
        bare
      />
    </div>
  );
}

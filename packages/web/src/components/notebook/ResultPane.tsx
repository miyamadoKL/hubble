// ResultPane コンポーネント
// SQLセルの実行結果を表示するパネル。Grid（表形式）/ Chart（グラフ）/
// Explain（実行計画）/ Details（実行メタ情報）の4タブ構成で、エラー発生時は
// 上部にエラーバナーも表示する。表示内容は execution ストアの CellExecution
// レコードによって完全に駆動される。
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
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
import { ResultGrid } from './ResultGrid';
import { ErrorPanel } from './ErrorPanel';
import { formatBytes, formatDuration, formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';
import { CSV_REEXEC_UNAVAILABLE } from '@hubble/contracts';
import { toast } from '../common/Toast';
import {
  copyResultToClipboard,
  downloadCsvUrl,
  downloadXlsxUrl,
  exportQuery,
  isCellRunning,
  type CellExecution,
} from '../../execution';
import { useT, type TFn } from '../../i18n/t';
import { useLocale, type Locale } from '../../i18n/locale';
import { commonMessages } from '../../i18n/messages/common';
import { notebookMessages, queryStateLabel } from '../../i18n/messages/notebook';

/** ResultPane 内で使う辞書の合成。共通文言（Loading chart…/Export failed 等）+ notebook 固有文言。 */
const resultPaneDict = { ...commonMessages, ...notebookMessages } as const;

// Intl API 用のロケールタグへ変換する（ja → 'ja-JP', en → 'en-US'）。
// 日時の絶対表示（Details タブの送信日時/完了日時）でのみ使う。
function toIntlLocale(locale: Locale): string {
  return locale === 'ja' ? 'ja-JP' : 'en-US';
}

const ChartPanel = lazy(() =>
  import('./ChartPanel').then((module) => ({ default: module.ChartPanel })),
);

// 結果ペインで切り替え可能なタブの種類。
type ResultTab = 'grid' | 'chart' | 'explain' | 'details';

/** ResultPane の props */
interface ResultPaneProps {
  // ノートブックのセルID（セルごとのチャート設定、結果表示域の高さの紐付けに使う）。
  cellId: string;
  /** 結果表示域の高さ調整を永続化するためのノートブックID。未確定（context.notebookId 未設定）なら高さ調整は無効化される。 */
  notebookId?: string;
  // このセルの実行状態全体（列、行、統計、エラー、状態など）を持つレコード。
  cell: CellExecution;
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
export function ResultPane({
  cellId,
  notebookId,
  cell,
  explainText,
  explainRunning,
  onExplain,
}: ResultPaneProps) {
  const t = useT(resultPaneDict);
  const { locale } = useLocale();
  // 現在選択中のタブ（初期値は Grid）。
  const [tab, setTab] = useState<ResultTab>('grid');
  // 「結果をコピー」ボタンの一時的な成功表示（コピー完了アイコンを1.5秒だけ出す）用フラグ。
  const [copied, setCopied] = useState(false);
  // このセルの実行がエラーになっているかどうか。
  const hasError = Boolean(cell.error);

  // タブバーに表示するタブの定義（id、ラベル、アイコン）。
  const TABS: TabItem<ResultTab>[] = [
    { id: 'grid', label: t('gridTab'), icon: Table2 },
    { id: 'chart', label: t('chartTab'), icon: BarChart3 },
    { id: 'explain', label: t('explainTab'), icon: FileText },
    { id: 'details', label: t('detailsTab'), icon: Info },
  ];

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
      {/* エラーバナー: タブより優先して最上部に表示する。 */}
      {hasError && cell.error && <ErrorPanel error={cell.error} />}

      {/* タブ切り替えバー + 右側のアクションボタン群（コピーと CSV ダウンロード）。 */}
      <div
        data-testid="result-pane-toolbar"
        className="flex items-center justify-between gap-2 pr-2"
      >
        <Tabs items={TABS} value={tab} onChange={setTab} className="flex-1" />
        <div className="flex items-center gap-0.5">
          <IconButton
            icon={copied ? Check : Clipboard}
            label={copied ? t('copiedLabel') : t('copyAsTsvHtml')}
            size="sm"
            disabled={cell.rows.length === 0}
            onClick={onCopy}
          />
          <ExportMenu
            queryId={cell.queryId}
            disabled={!cell.queryId || running}
            truncated={cell.truncated}
            csvReexecAllowed={cell.csvReexecAllowed}
            t={t}
          />
        </div>
      </div>

      {/* Gridタブ: 列が無く実行中でもなければ空状態、それ以外は結果テーブルを表示する。 */}
      {tab === 'grid' &&
        (cell.columns.length === 0 && !running ? (
          // 結果が無いケース。エラー起因か、単に0件だったかでメッセージを出し分ける。
          <div className="bg-surface-sunken">
            <EmptyState
              icon={Table2}
              title={hasError ? t('noResultTitle') : t('noRowsTitle')}
              description={hasError ? t('statementFailedDesc') : t('noRowsDesc')}
              compact
            />
          </div>
        ) : (
          <>
            {/* 実際の結果テーブル本体。queryId と行数情報を渡すことで、
                列プロファイルと server-side filter / sort が有効になる。 */}
            <ResultGrid
              columns={cell.columns}
              rows={cell.rows}
              rowsVersion={cell.rowsVersion}
              queryId={cell.queryId || undefined}
              totalRows={cell.rowCount}
              complete={!running && cell.state === 'finished'}
              notebookId={notebookId}
              cellId={cellId}
            />
            <div className="flex items-center justify-between border-t border-border-base bg-surface-base px-3 py-1.5">
              <span className="font-mono text-2xs text-ink-subtle">
                {t('resultFooter', {
                  rows: formatInt(cell.rowCount),
                  columns: cell.columns.length,
                })}
              </span>
              {/* 行数上限で結果が打ち切られている場合の警告表示。 */}
              {cell.truncated && (
                <span className="inline-flex items-center gap-1 text-2xs font-medium text-warning">
                  <TriangleAlert size={11} strokeWidth={2} />
                  {t('resultTruncatedWarning')}
                </span>
              )}
            </div>
          </>
        ))}

      {/* Chartタブ: 現在の結果列と行をグラフ描画パネルに渡す。 */}
      {tab === 'chart' && (
        <Suspense
          fallback={
            <div className="flex h-80 items-center justify-center text-xs text-ink-muted">
              {t('loadingChart')}
            </div>
          }
        >
          <ChartPanel
            cellId={cellId}
            columns={cell.columns}
            rows={cell.rows}
            rowsVersion={cell.rowsVersion}
          />
        </Suspense>
      )}

      {/* Explainタブ: EXPLAIN実行結果のプレーンテキストを表示する（下記 ExplainView 参照）。 */}
      {tab === 'explain' && (
        <ExplainView text={explainText} running={explainRunning} onRun={onExplain} t={t} />
      )}

      {/* Detailsタブ: クエリID、実行時刻、統計情報などのメタ情報を一覧表示する。 */}
      {tab === 'details' && (
        <div className="bg-surface-sunken px-4 py-2">
          <DetailRow label={t('detailQueryId')} value={cell.queryId || '—'} />
          <DetailRow label={t('detailTrinoQueryId')} value={cell.trinoQueryId ?? '—'} />
          <DetailRow
            label={t('detailSubmitted')}
            value={
              cell.startedAt ? new Date(cell.startedAt).toLocaleString(toIntlLocale(locale)) : '—'
            }
            mono={false}
          />
          <DetailRow
            label={t('detailFinished')}
            value={
              cell.finishedAt ? new Date(cell.finishedAt).toLocaleString(toIntlLocale(locale)) : '—'
            }
            mono={false}
          />
          <DetailRow
            label={t('detailState')}
            value={queryStateLabel(cell.state, locale)}
            mono={false}
          />
          <DetailRow
            label={t('detailElapsed')}
            value={formatDuration(stats?.elapsedTimeMillis ?? 0)}
          />
          <DetailRow
            label={t('detailWallTime')}
            value={formatDuration(stats?.wallTimeMillis ?? 0)}
          />
          <DetailRow
            label={t('detailProcessedRows')}
            value={formatInt(stats?.processedRows ?? 0)}
          />
          <DetailRow
            label={t('detailProcessedBytes')}
            value={formatBytes(stats?.processedBytes ?? 0)}
          />
          <DetailRow
            label={t('detailPeakMemory')}
            value={formatBytes(stats?.peakMemoryBytes ?? 0)}
          />
          <DetailRow
            label={t('detailSplits')}
            value={`${formatInt(stats?.completedSplits ?? 0)} / ${formatInt(stats?.totalSplits ?? 0)}`}
          />
          <DetailRow
            label={t('detailWorkerNodes')}
            value={stats?.nodes ? formatInt(stats.nodes) : '—'}
          />
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
  t,
}: {
  // EXPLAIN結果のプレーンテキスト（未取得ならundefined）
  text?: string;
  // EXPLAINクエリが実行中かどうか
  running?: boolean;
  // 「Run EXPLAIN」ボタン押下時のハンドラー
  onRun?: () => void;
  t: TFn<typeof resultPaneDict>;
}) {
  // 実行中は専用のローディングメッセージを表示する。
  if (running) {
    return (
      <div className="bg-surface-sunken px-4 py-6 text-center font-mono text-xs text-ink-muted">
        {t('explainRunningMessage')}
      </div>
    );
  }
  // まだ一度もEXPLAINを実行していない（text未定義）場合は、実行を促す空状態を表示する。
  if (text === undefined) {
    return (
      <div className="bg-surface-sunken">
        <EmptyState
          icon={FileText}
          title={t('explainPlanTitle')}
          description={t('explainPlanDesc')}
          compact
          action={
            onRun ? (
              <Button size="sm" icon={FileText} onClick={onRun}>
                {t('runExplainButton')}
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
      {text || t('emptyPlanText')}
    </pre>
  );
}

// S3 / Google Sheets への外部エクスポートの種類。
type ExternalExportAction = 's3-csv' | 's3-xlsx' | 'sheets';

/** ExportMenu のメニュー項目 1 行分。ダウンロード系は `a[href]`、外部エクスポート系はボタン。 */
function ExportMenuItem({
  href,
  download,
  onSelect,
  disabled,
  children,
}: {
  /** ダウンロード URL（指定時は `a[href]` として描画し、サーバーにストリーミングさせる）。 */
  href?: string;
  /** `a[download]` に設定するファイル名。 */
  download?: string;
  /** クリック時のハンドラー（外部エクスポート系、またはメニューを閉じる処理）。 */
  onSelect: () => void;
  /** 項目を無効化するかどうか。 */
  disabled?: boolean;
  children: ReactNode;
}) {
  const className = cn(
    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
    disabled ? 'pointer-events-none text-ink-subtle opacity-50' : 'text-ink-base',
    !disabled && 'hover:bg-accent-soft hover:text-accent',
  );
  // CSV / xlsx のダウンロードは fetch + blob 化のバッファリングを避けるため、
  // 素の `a[href]` でサーバーのストリーミングレスポンスに直接つなぐ。
  if (href !== undefined) {
    return (
      <a role="menuitem" href={href} download={download} className={className} onClick={onSelect}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" role="menuitem" onClick={onSelect} className={className}>
      {children}
    </button>
  );
}

/** ExportMenu のセクション見出し。 */
function ExportMenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-1.5 pb-0.5 text-2xs font-semibold tracking-wider text-ink-subtle uppercase">
      {children}
    </p>
  );
}

/**
 * 結果のダウンロードと外部エクスポートを 1 つに集約したメニュー。
 * 旧 UI では CSV / XLSX / S3 の 3 コントロールが並びサイズも不揃いだったため、
 * 固定ラベル「Export」のトリガー 1 つにまとめ、メニュー内を
 * Download（CSV zip / CSV / XLSX）と Export to（S3 / Google Sheets）に分ける。
 */
function ExportMenu({
  queryId,
  disabled,
  truncated,
  csvReexecAllowed,
  t,
}: {
  queryId: string;
  disabled: boolean;
  truncated: boolean;
  csvReexecAllowed: boolean;
  t: TFn<typeof resultPaneDict>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 外側クリック判定に使うルート要素への参照。
  const rootRef = useRef<HTMLDivElement>(null);

  // メニューが開いている間だけ、外側クリックと Escape でメニューを閉じるリスナーを登録する。
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 行数上限で打ち切られ、かつ全行の再実行ダウンロードもできないケースの注記。
  const partialOnly = truncated && !csvReexecAllowed;

  const runExport = async (action: ExternalExportAction) => {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      const response =
        action === 'sheets'
          ? await exportQuery(queryId, { destination: 'sheets' })
          : await exportQuery(queryId, {
              destination: 's3',
              format: action === 's3-xlsx' ? 'xlsx' : 'csv',
              gzip: action === 's3-csv' ? true : undefined,
            });
      if (response.destination === 's3') {
        toast.success(t('exportedToS3Toast'), response.objectKey);
      } else {
        toast.success(t('exportedToSheetsToast'), response.url);
        window.open(response.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      toast.error(t('exportFailedToast'), err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      {/* トリガー: 固定ラベル「Export」。IconButton (sm) と同じ h-6 で高さを揃える。 */}
      <button
        type="button"
        aria-label={t('exportResultAria')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-md border border-border-base px-2 text-2xs font-medium transition-colors',
          'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-40',
          open && 'border-accent ring-1 ring-accent/30',
        )}
      >
        <Download size={13} strokeWidth={1.75} />
        {t('exportTrigger')}
        <ChevronDown
          size={12}
          strokeWidth={1.75}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute top-full right-0 z-50 mt-1 w-52 rounded-md border border-border-strong',
            'bg-surface-overlay p-1 shadow-lg',
            'animate-[fadeIn_150ms_ease-out]',
          )}
        >
          <ExportMenuLabel>{t('downloadSectionLabel')}</ExportMenuLabel>
          <ExportMenuItem
            href={downloadCsvUrl(queryId, 'zip')}
            download={`result-${queryId}.zip`}
            onSelect={() => setOpen(false)}
          >
            {t('csvZipOption')}
          </ExportMenuItem>
          <ExportMenuItem
            href={downloadCsvUrl(queryId, 'csv')}
            download={`result-${queryId}.csv`}
            onSelect={() => setOpen(false)}
          >
            {t('csvOption')}
          </ExportMenuItem>
          <ExportMenuItem
            href={downloadXlsxUrl(queryId)}
            download={`result-${queryId}.xlsx`}
            onSelect={() => setOpen(false)}
          >
            {t('xlsxOption')}
          </ExportMenuItem>
          <ExportMenuLabel>{t('exportToSectionLabel')}</ExportMenuLabel>
          <ExportMenuItem disabled={busy} onSelect={() => void runExport('s3-csv')}>
            {t('s3CsvOption')}
          </ExportMenuItem>
          <ExportMenuItem disabled={busy} onSelect={() => void runExport('s3-xlsx')}>
            {t('s3XlsxOption')}
          </ExportMenuItem>
          <ExportMenuItem disabled={busy} onSelect={() => void runExport('sheets')}>
            {t('googleSheetsOption')}
          </ExportMenuItem>
          {/* 打ち切り済みで再実行もできない場合、ダウンロードが部分データになる旨を注記する。 */}
          {partialOnly && (
            <p className="border-t border-border-subtle px-2 pt-1.5 pb-1 text-2xs text-warning">
              {t('partialDownloadNote', { code: CSV_REEXEC_UNAVAILABLE })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

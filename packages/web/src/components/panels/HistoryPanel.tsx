/**
 * クエリ実行履歴パネル（アシストサイドバー内）。
 *
 * `GET /api/history` を offset ページング（1 ページ 50 件）で取得し、state
 * （all / finished / failed / canceled / running）によるフィルタチップと、各行を
 * 展開すると SQL 全文、エラーメッセージ、trinoQueryId 等の詳細を表示する UI を提供する。
 * 展開した行からは「Insert」（現在のカーソル位置に SQL を挿入）と「New cell」（新規 SQL
 * セルとして追加）の操作ができる。パネルがマウントされるたびに 1 ページ目を再取得する
 * ことで、直前に実行したクエリの履歴が確実に反映されるようにしている。
 */
import { useState } from 'react';
import type { HistoryResponse, QueryHistoryEntry } from '@hubble/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FilePlus2, History, TextCursorInput } from 'lucide-react';
import { fetchHistory, HISTORY_PAGE_SIZE } from '../../api/history';
import { insertAtActiveCursor, addSqlCellWithSource } from '../../notebook';
import { nextOffset, filterToStateParam, type HistoryFilter } from './historyPaging';
import { StateBadge } from '../common/StateBadge';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { formatDuration, formatInt, formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';

/**
 * History panel (design.md §5: offset ページング 50 件, state フィルタチップ, 各行
 * の詳細 + 新規セルへ). Self-contained: drives an offset-paging reducer over
 * `GET /api/history`, auto-refetches the first page on mount (so executions show
 * up), and exposes a state-filter chip row. Each row expands to the full
 * statement + metadata, with insert / new-cell actions.
 */

// フィルタチップとして表示する state 一覧（id は API へ渡す値、label は画面表示用）。
const FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'finished', label: 'Finished' },
  { id: 'failed', label: 'Failed' },
  { id: 'canceled', label: 'Canceled' },
  { id: 'running', label: 'Running' },
];

/**
 * 履歴一覧の 1 行分を描画するコンポーネント。
 * 折りたたみ時は state バッジ、相対時刻、SQL 文の 1 行要約、行数/所要時間を表示し、
 * クリックすると展開して SQL 全文、エラー詳細、trinoQueryId、Insert / New cell の
 * 操作ボタンを表示する。
 *
 * @param entry 履歴 1 件分のデータ（SQL 文、state、実行時刻、行数など）。
 * @param now 相対時刻表示（"3分前" など）の基準となる現在時刻。
 * @param expanded この行が展開表示中かどうか。
 * @param onToggle 行クリック時に呼び出す、展開状態を切り替えるコールバック。
 */
function HistoryRow({
  entry,
  now,
  expanded,
  onToggle,
}: {
  entry: QueryHistoryEntry;
  now: Date;
  expanded: boolean;
  onToggle: () => void;
}) {
  // SQL 文の改行と連続空白を単一スペースに畳んで、折りたたみ表示用の 1 行要約を作る。
  const oneLine = entry.statement.replace(/\s+/g, ' ').trim();
  return (
    <li className="group border-b border-border-subtle">
      {/* 行全体がクリック可能なボタン。押すたびに展開/折りたたみをトグルする。 */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-sunken"
      >
        <div className="min-w-0 flex-1">
          {/* state バッジ（finished/failed/running 等）と実行開始からの相対時刻 */}
          <div className="flex items-center gap-2">
            <StateBadge state={entry.state} />
            <span className="font-mono text-2xs text-ink-subtle">
              {formatRelativeTime(entry.submittedAt, now)}
            </span>
          </div>
          {/* SQL 文の 1 行要約（折りたたみ表示） */}
          <p className="mt-1 truncate font-mono text-xs text-ink-base">{oneLine}</p>
          {/* catalog.schema、取得行数、所要時間のサマリ行 */}
          <div className="mt-1 flex items-center gap-3 font-mono text-2xs text-ink-subtle">
            {(entry.catalog || entry.schema) && (
              <span>
                {entry.catalog ?? '—'}.{entry.schema ?? '—'}
              </span>
            )}
            {entry.state === 'finished' && <span>{formatInt(entry.rowCount)} rows</span>}
            <span>{formatDuration(entry.elapsedMs)}</span>
          </div>
          {/* 折りたたみ中のみ、エラーメッセージの先頭部分をプレビュー表示する */}
          {entry.errorMessage && !expanded && (
            <p className="mt-1 truncate font-mono text-2xs text-error">{entry.errorMessage}</p>
          )}
        </div>
      </button>

      {/* 展開時のみ描画する詳細ブロック: SQL 全文、エラー全文、メタデータ、操作ボタン */}
      {expanded && (
        <div className="px-3 pb-2.5">
          {/* SQL 文の全文（スクロール可能な pre） */}
          <pre className="max-h-48 overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap text-ink-base">
            {entry.statement}
          </pre>
          {/* エラーメッセージの全文（存在する場合のみ） */}
          {entry.errorMessage && (
            <p className="mt-1.5 font-mono text-2xs whitespace-pre-wrap text-error">
              {entry.errorMessage}
            </p>
          )}
          {/* trinoQueryId、行数、所要時間の詳細メタデータ */}
          <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-2xs text-ink-subtle">
            {entry.trinoQueryId && (
              <div className="col-span-2 flex gap-2">
                <dt className="text-ink-subtle">query</dt>
                <dd className="truncate text-ink-muted">{entry.trinoQueryId}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt>rows</dt>
              <dd className="text-ink-muted">{formatInt(entry.rowCount)}</dd>
            </div>
            <div className="flex gap-2">
              <dt>elapsed</dt>
              <dd className="text-ink-muted">{formatDuration(entry.elapsedMs)}</dd>
            </div>
          </dl>
          {/* この SQL 文をノートブックへ反映するための操作ボタン群 */}
          <div className="mt-2 flex items-center gap-2">
            {/* 現在アクティブなセルのカーソル位置に SQL 文をそのまま挿入する */}
            <Button
              variant="default"
              size="sm"
              icon={TextCursorInput}
              onClick={() => insertAtActiveCursor(entry.statement)}
            >
              Insert
            </Button>
            {/* 新しい SQL セルとしてこの文を追加する。成功時のみトースト通知を出す。 */}
            <Button
              variant="ghost"
              size="sm"
              icon={FilePlus2}
              onClick={() => {
                if (addSqlCellWithSource(entry.statement)) toast.success('New SQL cell');
              }}
            >
              New cell
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * 履歴パネル本体（アシストサイドバーの「History」タブから表示される）。
 * state フィルタチップ、履歴一覧（offset ページングによる「Load more」）、
 * ローディング/エラー/空表示を統括する。props は取らず、内部で API 取得と
 * ページング状態をすべて完結させる自己完結型コンポーネント。
 */
export function HistoryPanel() {
  // 選択中の state フィルタ（"all" がデフォルト）。
  const [filter, setFilter] = useState<HistoryFilter>('all');
  // 現在展開中の履歴行 id。null であれば全行折りたたみ状態。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 相対時刻表示の基準となる現在時刻（レンダーごとに固定して行間でずれないようにする）。
  const now = new Date();

  // Offset paging via useInfiniteQuery (design.md §5: offset ページング 50 件,
  // もっと見る). `getNextPageParam` reuses the same paging math as the reducer.
  // `refetchOnMount: 'always'` re-pulls the first page whenever the panel shows,
  // so freshly-executed queries appear (design.md §5: 自動 refetch).
  const query = useInfiniteQuery({
    queryKey: ['history', filter],
    queryFn: ({ pageParam }) =>
      fetchHistory({
        offset: pageParam,
        limit: HISTORY_PAGE_SIZE,
        state: filterToStateParam(filter),
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: HistoryResponse, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return nextOffset(loaded, lastPage.total);
    },
    refetchOnMount: 'always',
  });

  // Flatten pages, de-duplicating by id (an overlapping refetch can't double up).
  // 取得済みの各ページを 1 本の配列にフラット化する。id で重複排除しているのは、
  // 1 ページ目の refetch と既存ページが範囲的に重なった場合でも同じ行が二重に
  // 表示されないようにするため。
  const items: QueryHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const page of query.data?.pages ?? []) {
    for (const entry of page.items) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        items.push(entry);
      }
    }
  }
  // サーバーが報告する一致件数の合計（最後に取得したページの total を採用）。
  const total = query.data?.pages.at(-1)?.total ?? 0;

  return (
    <div className="flex flex-col">
      {/* state フィルタチップの行。押下したフィルタで一覧が絞り込まれる。 */}
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-2xs font-medium transition-colors',
              filter === f.id
                ? 'bg-accent-soft text-accent'
                : 'bg-surface-sunken text-ink-muted hover:text-ink-strong',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 一覧本体: エラー時／空データ時／通常時の 3 パターンを出し分ける。 */}
      {query.isError && items.length === 0 ? (
        // 取得エラーで表示できる行が 1 件もない場合の空状態表示。
        <EmptyState
          icon={History}
          title="Couldn't load history"
          description="The server didn't respond."
          compact
        />
      ) : items.length === 0 && !query.isPending ? (
        // 取得は成功したが該当履歴が 0 件の場合の空状態表示（フィルタ別にメッセージを変える）。
        <EmptyState
          icon={History}
          title={filter === 'all' ? 'No history yet' : 'No matching history'}
          description={
            filter === 'all'
              ? 'Executed queries are recorded here automatically.'
              : 'No queries with this state.'
          }
          compact
        />
      ) : (
        // 履歴一覧本体。各行は HistoryRow が展開状態を own せず、親の expandedId で制御される。
        <ul className="flex flex-col">
          {items.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              now={now}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId((id) => (id === entry.id ? null : entry.id))}
            />
          ))}
        </ul>
      )}

      {/* 初回ロード中、または次ページ取得中に表示するローディングインジケーター。 */}
      {(query.isPending || query.isFetchingNextPage) && (
        <div className="flex items-center justify-center gap-2 py-3 font-mono text-2xs text-ink-subtle">
          <Spinner size={13} /> Loading…
        </div>
      )}

      {/* まだ未取得のページが残っている場合に表示する「Load more」ボタン。
          押すと useInfiniteQuery の fetchNextPage を呼び出し、次の offset を取得する。 */}
      {!query.isFetchingNextPage && query.hasNextPage && (
        <div className="px-3 py-2">
          <Button
            variant="default"
            size="sm"
            className="w-full justify-center"
            onClick={() => void query.fetchNextPage()}
          >
            Load more ({items.length} of {total})
          </Button>
        </div>
      )}
    </div>
  );
}

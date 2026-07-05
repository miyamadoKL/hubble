/**
 * 保存済みクエリ（Saved Queries）パネル（アシストサイドバー内）。
 *
 * 検索ボックスの入力をデバウンスして `GET /api/saved-queries` を呼び出し、一覧を
 * 表示する。各行はお気に入りトグルと展開表示（SQL 全文 + Insert / New cell / Delete
 * 操作）を持つ。お気に入りのトグルと削除は React Query の mutation で行い、成功時に
 * 一覧クエリを invalidate して再取得させる。削除は確認モーダルを経由する。
 */
import { useState } from 'react';
import type { SavedQuery } from '@hubble/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookMarked, FilePlus2, Star, TextCursorInput, Trash2 } from 'lucide-react';
import {
  listSavedQueries,
  updateSavedQuery,
  deleteSavedQuery,
  listSavedQueryShares,
  updateSavedQueryShares,
} from '../../api/savedQueries';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { insertAtActiveCursor, addSqlCellWithSource } from '../../notebook';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { ShareModal } from '../common/ShareModal';
import { DocumentShareBadge } from '../common/DocumentShareBadge';
import { cn } from '../../utils/cn';
import { isDocumentOwner } from '../../utils/documentShare';
import { useDatasources } from '../../hooks/useDatasources';
import { DatasourceBadge } from '../common/DatasourceBadge';
import { trySelectDatasource } from '../../utils/applyDatasource';
import { Share2 } from 'lucide-react';

/**
 * Saved queries panel (一覧 / 検索 / お気に入りトグル / 削除 /
 * 詳細 / 挿入). Self-contained: fetches its own list (debounced search), and
 * mutates favorites / deletions through the saved-query API, invalidating the
 * list on success. Insert drops the statement at the caret; "New cell" appends a
 * fresh SQL cell.
 */

// React Query のキャッシュキーを生成するヘルパー。検索語ごとに別キャッシュとして扱う。
const savedQueriesKey = (q: string) => ['saved-queries', 'list', q] as const;

/**
 * 保存済みクエリ一覧の 1 行分を描画するコンポーネント。
 * 折りたたみ時は名前、SQL 文の 1 行要約、説明を表示し、お気に入り星アイコンで
 * トグルできる。展開すると SQL 全文と Insert / New cell / Delete の操作ボタンを表示する。
 *
 * @param query 表示対象の保存済みクエリ。
 * @param expanded この行が展開表示中かどうか。
 * @param onToggleExpand 行本体クリック時に呼ぶ、展開状態を切り替えるコールバック。
 * @param onToggleFavorite 星アイコンクリック時に呼ぶ、お気に入り状態を切り替えるコールバック。
 * @param onInsert 「Insert」ボタン押下時に呼ぶコールバック。
 * @param onNewCell 「New cell」ボタン押下時に呼ぶコールバック。
 * @param onDelete 「Delete」ボタン押下時に呼ぶコールバック（削除確認モーダルを開く）。
 */
function SavedRow({
  query,
  expanded,
  datasources,
  onToggleExpand,
  onToggleFavorite,
  onInsert,
  onNewCell,
  onDelete,
  onShare,
}: {
  query: SavedQuery;
  expanded: boolean;
  datasources: ReturnType<typeof useDatasources>['datasources'];
  onToggleExpand: () => void;
  onToggleFavorite: () => void;
  onInsert: () => void;
  onNewCell: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const owner = isDocumentOwner(query.myPermission);
  // SQL 文の改行と連続空白を単一スペースに畳んで、折りたたみ表示用の 1 行要約を作る。
  const oneLine = query.statement.replace(/\s+/g, ' ').trim();
  return (
    <li className="group border-b border-border-subtle">
      <div className="flex items-start gap-2 px-3 py-2 transition-colors hover:bg-surface-sunken">
        {/* 所有者のみお気に入りトグルを表示する（共有行の isFavorite は所有者側の状態）。 */}
        {owner ? (
          <button
            type="button"
            aria-label={query.isFavorite ? 'Unfavorite' : 'Favorite'}
            aria-pressed={query.isFavorite}
            onClick={onToggleFavorite}
            className="mt-0.5 shrink-0 rounded-sm p-0.5"
          >
            <Star
              size={14}
              strokeWidth={1.75}
              className={cn(
                query.isFavorite
                  ? 'fill-accent text-accent'
                  : 'text-ink-subtle hover:text-ink-muted',
              )}
            />
          </button>
        ) : (
          <span className="mt-0.5 w-[22px] shrink-0" aria-hidden />
        )}
        {/* 名前、SQL 1 行要約、説明を表示する、展開トグル用のクリック領域。 */}
        <button
          type="button"
          onClick={onToggleExpand}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
        >
          <p className="truncate text-sm font-medium text-ink-strong">{query.name}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <DatasourceBadge datasourceId={query.datasourceId} datasources={datasources} />
            <DocumentShareBadge owner={query.owner} myPermission={query.myPermission} />
            <p className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-subtle">{oneLine}</p>
          </div>
          {query.description && (
            <p className="mt-0.5 truncate text-xs text-ink-muted">{query.description}</p>
          )}
        </button>
      </div>

      {/* 展開時のみ描画する詳細ブロック: SQL 全文と操作ボタン群。 */}
      {expanded && (
        <div className="px-3 pb-2.5">
          <pre className="max-h-40 overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap text-ink-base">
            {query.statement}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* 現在アクティブなセルのカーソル位置に SQL 文を挿入する。 */}
            <Button variant="default" size="sm" icon={TextCursorInput} onClick={onInsert}>
              Insert
            </Button>
            {/* 新しい SQL セルとしてこの文を追加する。 */}
            <Button variant="ghost" size="sm" icon={FilePlus2} onClick={onNewCell}>
              New cell
            </Button>
            {owner && (
              <Button variant="ghost" size="sm" icon={Share2} onClick={onShare}>
                Share
              </Button>
            )}
            {owner && (
              <Button
                variant="ghost"
                size="sm"
                icon={Trash2}
                onClick={onDelete}
                className="ml-auto text-ink-subtle hover:text-error"
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * 保存済みクエリパネル本体。
 *
 * @param search 検索語（親コンポーネントの検索ボックスから渡される）。300ms
 *   デバウンスしてから一覧取得のクエリキーに反映する。
 */
export function SavedQueriesPanel({ search }: { search: string }) {
  const queryClient = useQueryClient();
  const { datasources } = useDatasources();

  const applySavedDatasource = (query: SavedQuery) => {
    if (query.datasourceId) {
      trySelectDatasource(datasources, query.datasourceId);
    }
  };
  // 検索語を 300ms デバウンスし、入力のたびに API を叩かないようにする。
  const debounced = useDebouncedValue(search.trim(), 300);
  // 現在展開中の行 id。null であれば全行折りたたみ状態。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 削除確認モーダルの対象。null ならモーダルは非表示。
  const [pendingDelete, setPendingDelete] = useState<SavedQuery | null>(null);
  // 共有編集モーダルの対象。null なら非表示。
  const [pendingShare, setPendingShare] = useState<SavedQuery | null>(null);

  // デバウンス済み検索語で一覧を取得する。
  const list = useQuery({
    queryKey: savedQueriesKey(debounced),
    queryFn: () => listSavedQueries(debounced || undefined),
  });

  // 検索語に関わらず 'saved-queries' 系の一覧キャッシュをまとめて無効化し、再取得させる。
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['saved-queries', 'list'] });

  // お気に入りトグル用の mutation。既存フィールドはそのまま送り、isFavorite だけ反転させる。
  const favorite = useMutation({
    mutationFn: (q: SavedQuery) =>
      updateSavedQuery(q.id, {
        name: q.name,
        description: q.description,
        statement: q.statement,
        catalog: q.catalog,
        schema: q.schema,
        datasourceId: q.datasourceId,
        isFavorite: !q.isFavorite,
      }),
    onSuccess: invalidate,
    onError: () => toast.error('Update failed', 'Could not reach the server.'),
  });

  // 削除用の mutation。成功時は一覧を無効化して情報トーストを出す。
  const remove = useMutation({
    mutationFn: (id: string) => deleteSavedQuery(id),
    onSuccess: () => {
      invalidate();
      toast.info('Deleted', 'Saved query removed.');
    },
    onError: () => toast.error('Delete failed', 'Could not reach the server.'),
  });

  // 初回取得中はローディング表示のみを返す。
  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  // 取得エラー時の空状態表示。
  if (list.isError) {
    return (
      <EmptyState
        icon={BookMarked}
        title="Couldn't load saved queries"
        description="The server didn't respond."
        compact
      />
    );
  }

  const queries = list.data;
  // 検索結果 0 件（または保存済みクエリが 1 件も無い）場合の空状態表示。
  if (queries.length === 0) {
    return (
      <EmptyState
        icon={BookMarked}
        title={debounced ? 'No matches' : 'No saved queries'}
        description={
          debounced ? 'Try a different search term.' : 'Save a query from a cell to find it here.'
        }
        compact
      />
    );
  }

  // Favorites first, then by name.
  // お気に入りを先頭に、その中/外はそれぞれ名前の昇順で並べ替える。
  const sorted = [...queries].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {/* 保存済みクエリ一覧本体（お気に入り優先、名前順）。 */}
      <ul className="flex flex-col">
        {sorted.map((query) => (
          <SavedRow
            key={query.id}
            query={query}
            datasources={datasources}
            expanded={expandedId === query.id}
            onToggleExpand={() => setExpandedId((id) => (id === query.id ? null : query.id))}
            onToggleFavorite={() => favorite.mutate(query)}
            onInsert={() => {
              applySavedDatasource(query);
              insertAtActiveCursor(query.statement);
            }}
            onNewCell={() => {
              applySavedDatasource(query);
              if (addSqlCellWithSource(query.statement)) {
                toast.success('New SQL cell', `“${query.name}” added.`);
              }
            }}
            onDelete={() => setPendingDelete(query)}
            onShare={() => setPendingShare(query)}
          />
        ))}
      </ul>

      {/* 削除確認モーダル。pendingDelete が非 null のときのみ開く。
          Cancel で取り消し、Delete で実際の削除 mutation を実行してから閉じる。 */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete saved query?"
        description={
          pendingDelete ? `“${pendingDelete.name}” will be permanently removed.` : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
      <ShareModal
        open={pendingShare !== null}
        onClose={() => setPendingShare(null)}
        documentName={pendingShare?.name ?? ''}
        fetchShares={() => {
          if (!pendingShare) return Promise.reject(new Error('No document'));
          return listSavedQueryShares(pendingShare.id);
        }}
        updateShares={(shares) => {
          if (!pendingShare) return Promise.reject(new Error('No document'));
          return updateSavedQueryShares(pendingShare.id, shares);
        }}
      />
    </>
  );
}

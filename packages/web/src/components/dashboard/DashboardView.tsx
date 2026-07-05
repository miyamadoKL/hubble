/**
 * DashboardView.tsx
 *
 * ダッシュボードビュー (メインエリア)。widget を react-grid-layout の
 * グリッドに配置して表示する。閲覧モードでは各パネルが参照先クエリを実行して
 * 結果を描画し、編集モードではドラッグ/リサイズ/追加/削除と名前変更ができる。
 * 保存は明示的な Save ボタンで行う (グリッド操作のたびの自動 PUT はしない)。
 *
 * 外側の `DashboardView` がデータ取得と読み込み状態を担当し、編集本体の
 * `DashboardEditor` は dashboardId をキーに再マウントされる (WorkflowView と同じ構成)。
 */
import { useMemo, useState } from 'react';
import { GridLayout, useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { ArrowLeft, LayoutDashboard, Pencil, Plus, Save, Share2, Trash2 } from 'lucide-react';
import type { Dashboard, DashboardWidget } from '@hubble/contracts';
import { Button } from '../common/Button';
import { Spinner } from '../common/Spinner';
import { EmptyState } from '../common/EmptyState';
import { Modal } from '../common/Modal';
import { toast } from '../common/Toast';
import { useUiStore } from '../../stores/uiStore';
import {
  useCreateDashboard,
  useDashboard,
  useDeleteDashboard,
  useUpdateDashboard,
} from '../../hooks/useDashboards';
import { GitSyncControl } from '../github/GitSyncControl';
import { ShareModal } from '../common/ShareModal';
import { listDashboardShares, updateDashboardShares } from '../../api/dashboards';
import { isDocumentOwner } from '../../utils/documentShare';
import { AddWidgetModal } from './AddWidgetModal';
import { WidgetCard } from './WidgetCard';

/** グリッドの列数 (Redash と同じ感覚の 6 列)。 */
const GRID_COLS = 6;
/** グリッド 1 行分の高さ (px)。 */
const GRID_ROW_HEIGHT = 90;

/** widget の position を react-grid-layout の LayoutItem へ変換する。 */
function toLayout(widgets: DashboardWidget[]): Layout {
  return widgets.map((w) => ({
    i: w.id,
    x: w.position.col,
    y: w.position.row,
    w: w.position.sizeX,
    h: w.position.sizeY,
    minW: 1,
    minH: 1,
  }));
}

/** react-grid-layout のレイアウト変更を widget の position へ書き戻す。 */
function applyLayout(widgets: DashboardWidget[], layout: Layout): DashboardWidget[] {
  const byId = new Map(layout.map((item) => [item.i, item]));
  return widgets.map((w) => {
    const item = byId.get(w.id);
    if (!item) return w;
    return { ...w, position: { col: item.x, row: item.y, sizeX: item.w, sizeY: item.h } };
  });
}

/** 新規 widget を既存レイアウトの最下段へ配置した position を返す。 */
function placeAtBottom(widgets: DashboardWidget[], widget: DashboardWidget): DashboardWidget {
  const bottom = widgets.reduce((max, w) => Math.max(max, w.position.row + w.position.sizeY), 0);
  return { ...widget, position: { ...widget.position, col: 0, row: bottom } };
}

/**
 * ダッシュボードビューの外側。uiStore の dashboardView からモードを読み、
 * 既存ダッシュボードの取得状態を処理してからエディタ本体をマウントする。
 */
export function DashboardView() {
  const view = useUiStore((s) => s.dashboardView);
  const close = useUiStore((s) => s.closeDashboard);
  const id = view?.kind === 'dashboard' ? view.id : null;
  const query = useDashboard(id);

  if (view?.kind === 'new-dashboard') {
    return <DashboardEditor key="new" dashboard={null} onClose={close} />;
  }
  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> Loading dashboard…
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={LayoutDashboard}
          title="Couldn't load dashboard"
          description="It may have been deleted, or the server didn't respond."
        />
      </div>
    );
  }
  return (
    <DashboardEditor
      // id または updatedAt が変わったら (別ダッシュボードを開いた、GitHub pull など
      // サーバー側で内容が更新された) 再マウントして name/widgets を初期化し直す
      // (WorkflowView と同じ構成)。
      key={`${query.data.id}:${query.data.updatedAt}`}
      dashboard={query.data}
      onClose={close}
    />
  );
}

/**
 * ダッシュボードの表示と編集の本体。
 * @param dashboard 編集対象。null は新規作成。
 * @param onClose 閉じてノートブック表示へ戻るコールバック。
 */
function DashboardEditor({
  dashboard,
  onClose,
}: {
  dashboard: Dashboard | null;
  onClose: () => void;
}) {
  const isNew = dashboard === null;
  // 新規作成は最初から編集モードで開く。
  const [editing, setEditing] = useState(isNew);
  const [name, setName] = useState(dashboard?.name ?? 'Untitled dashboard');
  const [widgets, setWidgets] = useState<DashboardWidget[]>(dashboard?.widgets ?? []);
  const [dirty, setDirty] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const createMutation = useCreateDashboard();
  const updateMutation = useUpdateDashboard();
  const deleteMutation = useDeleteDashboard();
  const saving = createMutation.isPending || updateMutation.isPending;

  // 共有経由の view 権限では編集させない (サーバー側でも拒否されるが UI でも隠す)。
  const canEdit = isNew || dashboard.myPermission !== 'view';
  // 削除と共有管理は所有者のみ (サーバーも owner 以外を 403 にする)。
  const isOwner = !isNew && isDocumentOwner(dashboard.myPermission);

  const { width, containerRef, mounted } = useContainerWidth();
  const layout = useMemo(() => toLayout(widgets), [widgets]);

  const save = async () => {
    try {
      if (isNew) {
        const created = await createMutation.mutateAsync({
          name: name.trim() || 'Untitled dashboard',
          widgets,
        });
        // 作成後は保存済みダッシュボードとして開き直す。
        useUiStore.getState().openDashboard(created.id);
        toast.success('Dashboard created');
      } else {
        await updateMutation.mutateAsync({
          id: dashboard.id,
          body: {
            name: name.trim() || 'Untitled dashboard',
            description: dashboard.description,
            widgets,
          },
        });
        setDirty(false);
        setEditing(false);
        toast.success('Dashboard saved');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save dashboard');
    }
  };

  const remove = async () => {
    if (isNew) return;
    try {
      await deleteMutation.mutateAsync(dashboard.id);
      toast.success('Dashboard deleted');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete dashboard');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ヘッダー: [戻る] [名前] … [Add widget] [Edit/Save] [Delete] */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border-base px-3 py-2">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onClose}>
          Back
        </Button>
        <LayoutDashboard size={16} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
        {editing ? (
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            aria-label="Dashboard name"
            className="min-w-0 flex-1 rounded-md border border-border-base bg-surface-base px-2 py-1 text-sm font-medium text-ink-strong focus:border-accent focus:outline-none"
          />
        ) : (
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-strong">{name}</h1>
        )}
        {/* GitHub 連携ステータス (連携有効時のみ表示、クリックで同期モーダル)。 */}
        <GitSyncControl type="dashboard" id={dashboard?.id ?? null} documentName={name} />
        <div className="flex shrink-0 items-center gap-1.5">
          {editing && (
            <Button variant="default" size="sm" icon={Plus} onClick={() => setAddOpen(true)}>
              Add widget
            </Button>
          )}
          {canEdit &&
            (editing ? (
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            ) : (
              <Button variant="default" size="sm" icon={Pencil} onClick={() => setEditing(true)}>
                Edit
              </Button>
            ))}
          {isOwner && (
            <Button variant="ghost" size="sm" icon={Share2} onClick={() => setShareOpen(true)}>
              Share
            </Button>
          )}
          {isOwner && (
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              aria-label="Delete dashboard"
              onClick={() => setConfirmDelete(true)}
            />
          )}
        </div>
      </header>

      {/* グリッド本体。 */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-surface-sunken p-2">
        {widgets.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={LayoutDashboard}
              title="Empty dashboard"
              description={
                editing
                  ? 'Add a widget to get started.'
                  : 'This dashboard has no widgets yet. Click Edit to add some.'
              }
            />
          </div>
        ) : (
          mounted && (
            <GridLayout
              width={width}
              layout={layout}
              gridConfig={{ cols: GRID_COLS, rowHeight: GRID_ROW_HEIGHT, margin: [8, 8] }}
              dragConfig={{ enabled: editing, handle: '.dashboard-widget-drag-handle' }}
              resizeConfig={{ enabled: editing }}
              onLayoutChange={(next) => {
                // グリッド操作 (ドラッグ/リサイズ/衝突回避) の結果を widget へ書き戻す。
                if (!editing) return;
                setWidgets((prev) => applyLayout(prev, next));
                setDirty(true);
              }}
            >
              {widgets.map((w) => (
                <div key={w.id}>
                  <WidgetCard
                    widget={w}
                    editing={editing}
                    onRemove={() => {
                      setWidgets((prev) => prev.filter((x) => x.id !== w.id));
                      setDirty(true);
                    }}
                  />
                </div>
              ))}
            </GridLayout>
          )
        )}
      </div>

      {/* 未保存変更のヒント。 */}
      {editing && dirty && (
        <div className="shrink-0 border-t border-border-subtle px-3 py-1.5 font-mono text-2xs text-ink-subtle">
          Unsaved changes
        </div>
      )}

      {/* 共有編集モーダル (所有者のみ)。 */}
      {isOwner && dashboard && (
        <ShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          documentName={name}
          fetchShares={() => listDashboardShares(dashboard.id)}
          updateShares={(shares) => updateDashboardShares(dashboard.id, shares)}
        />
      )}

      <AddWidgetModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={(widget) => {
          setWidgets((prev) => [...prev, placeAtBottom(prev, widget)]);
          setDirty(true);
        }}
      />

      {/* 削除確認モーダル。 */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete dashboard?"
        description={`“${name}” will be permanently removed. Saved queries it references are not affected.`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

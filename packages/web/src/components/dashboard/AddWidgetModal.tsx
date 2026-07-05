/**
 * AddWidgetModal.tsx
 *
 * ダッシュボードへ widget を追加するモーダル。query widget
 * (保存済みクエリ + 表示形式) と text widget (Markdown) の 2 種を作成できる。
 * チャートの軸設定は結果の列構成に依存するため、ここでは viz の選択までとし、
 * 詳細は保存済みクエリ側のチャート設定 (cell.chart) を widget にコピーする
 * 運用ではなく、追加後にデフォルト設定 (reconcileConfig) で描画される。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DashboardWidget, WidgetViz } from '@hubble/contracts';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { listSavedQueries } from '../../api/savedQueries';
import { uid } from '../../utils/id';

const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

/** 表示形式の選択肢とラベル。 */
const VIZ_OPTIONS: { value: WidgetViz; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'chart', label: 'Chart' },
  { value: 'counter', label: 'Counter' },
];

/**
 * widget 追加モーダル。
 * @param open モーダルの表示状態。
 * @param onClose 閉じる操作のコールバック。
 * @param onAdd 追加確定時に新しい widget 定義 (position は仮値) を渡すコールバック。
 */
export function AddWidgetModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (widget: DashboardWidget) => void;
}) {
  const [kind, setKind] = useState<'query' | 'text'>('query');
  const [savedQueryId, setSavedQueryId] = useState('');
  const [viz, setViz] = useState<WidgetViz>('table');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  // 保存済みクエリの選択肢。モーダルを開いている間だけ取得する。
  const savedQueries = useQuery({
    queryKey: ['saved-queries', 'list'],
    queryFn: () => listSavedQueries(),
    enabled: open && kind === 'query',
  });

  if (!open) return null;

  const canAdd = kind === 'text' ? text.trim().length > 0 : savedQueryId.length > 0;

  const add = () => {
    // position は仮の値。実際の配置は DashboardView 側が空き位置を計算して上書きする。
    const position = { col: 0, row: 0, sizeX: 3, sizeY: 2 };
    if (kind === 'text') {
      onAdd({ id: uid('w'), kind: 'text', position, text });
    } else {
      onAdd({
        id: uid('w'),
        kind: 'query',
        position,
        savedQueryId,
        viz,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(viz === 'counter' ? { counter: { columnIndex: 0 } } : {}),
      });
    }
    // 次回のために入力をリセットして閉じる。
    setSavedQueryId('');
    setTitle('');
    setText('');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add widget"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!canAdd} onClick={add}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* widget 種別の切り替え。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Type</span>
          <div className="flex gap-2">
            {(['query', 'text'] as const).map((k) => (
              <Button
                key={k}
                variant={kind === k ? 'primary' : 'default'}
                size="sm"
                onClick={() => setKind(k)}
              >
                {k === 'query' ? 'Query' : 'Text'}
              </Button>
            ))}
          </div>
        </div>

        {kind === 'query' ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Saved query</span>
              <select
                value={savedQueryId}
                onChange={(e) => setSavedQueryId(e.target.value)}
                className={TEXT_INPUT}
              >
                <option value="">Select a saved query…</option>
                {(savedQueries.data ?? []).map((sq) => (
                  <option key={sq.id} value={sq.id}>
                    {sq.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Display as</span>
              <div className="flex gap-2">
                {VIZ_OPTIONS.map((opt) => (
                  <Button
                    key={opt.value}
                    variant={viz === opt.value ? 'primary' : 'default'}
                    size="sm"
                    onClick={() => setViz(opt.value)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Title (optional)</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to the saved query name"
                className={TEXT_INPUT}
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Markdown</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder="# Heading&#10;Some **markdown** text…"
              className={TEXT_INPUT}
            />
          </label>
        )}
      </div>
    </Modal>
  );
}

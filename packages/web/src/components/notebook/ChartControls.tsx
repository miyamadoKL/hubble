/**
 * ChartControls.tsx
 *
 * ノートブックのチャートセルに表示される、コンパクトなチャート設定バー。
 * チャート種別の選択、X/Y 軸に使う列の選択、並び替え順、表示行数の上限、
 * （散布図の場合は）グループ化列とサイズ列の選択を行う UI をまとめて提供する。
 * このコンポーネント自身は状態を持たず、`config` を受け取り `onChange` で
 * 変更後の設定を親へ通知するだけの制御コンポーネント（Controlled Component）。
 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownNarrowWide,
  BarChart3,
  ChartScatter,
  ChevronDown,
  Check,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Dropdown } from '../common/Dropdown';
import { cn } from '../../utils/cn';
import {
  groupCandidates,
  xCandidates,
  yCandidates,
  type ChartConfig,
  type ChartType,
  type ColumnInfo,
  type LimitOption,
  type SortOrder,
} from '../../chart';

/**
 * The compact chart control row (design.md §5): chart-type icons, X / Y axis
 * pickers (Y multi-select, numeric only), sort, row-limit, plus group + size for
 * scatter. Pure presentation — config flows down, edits flow up via `onChange`.
 */

// チャート種別ごとのアイコンとラベルの対応表。セグメントコントロールの描画に使う。
const TYPES: { type: ChartType; icon: LucideIcon; label: string }[] = [
  { type: 'bars', icon: BarChart3, label: 'Bars' },
  { type: 'lines', icon: LineChartIcon, label: 'Lines' },
  { type: 'timeline', icon: TrendingUp, label: 'Timeline' },
  { type: 'pie', icon: PieChartIcon, label: 'Pie' },
  { type: 'scatter', icon: ChartScatter, label: 'Scatter' },
];

/**
 * チャート設定バー本体。チャート種別、軸列、並び替え、行数上限などを一列に並べて表示し、
 * ユーザーの操作を `onChange` で親コンポーネントへ伝搬する。
 *
 * @param cols - クエリ結果から得られる列情報の一覧（軸の選択肢を作るのに使う）。
 * @param config - 現在のチャート設定（種別、軸、並び替え、行数上限など）。
 * @param onChange - 設定が変更されたときに、更新後の ChartConfig を渡して呼ばれる。
 */
export function ChartControls({
  cols,
  config,
  onChange,
}: {
  cols: ColumnInfo[];
  config: ChartConfig;
  onChange: (next: ChartConfig) => void;
}) {
  // X 軸、Y 軸、グループ化に使用できる列の候補を、現在のチャート種別に応じて算出する。
  const xs = xCandidates(cols, config.type);
  const ys = yCandidates(cols);
  const groups = groupCandidates(cols);

  // 設定の一部だけを更新して onChange を呼ぶためのヘルパー（部分更新）。
  const patch = (p: Partial<ChartConfig>) => onChange({ ...config, ...p });

  // チャート種別によって X/Y 軸ラベルの文言を変える（散布図は「measure」、円グラフは「Value」など）。
  const xLabel = config.type === 'scatter' ? 'X (measure)' : 'X axis';
  const yLabel = config.type === 'pie' ? 'Value' : 'Y axis';

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle bg-surface-base px-3 py-2"
      data-testid="chart-controls"
    >
      {/* Chart type — icon segmented control. */}
      {/* チャート種別をアイコンで切り替えるセグメントコントロール。 */}
      <div className="inline-flex items-center gap-0.5 rounded-md border border-border-base bg-surface-inset p-0.5">
        {TYPES.map(({ type, icon: Icon, label }) => {
          // active: このボタンが現在選択中のチャート種別かどうか（強調表示に使う）。
          const active = config.type === type;
          return (
            <button
              key={type}
              type="button"
              aria-label={label}
              aria-pressed={active}
              title={label}
              onClick={() => patch({ type })}
              className={cn(
                'inline-flex h-6 w-7 items-center justify-center rounded-sm transition-colors duration-100',
                active
                  ? 'bg-surface-raised text-accent shadow-sm'
                  : 'text-ink-muted hover:text-ink-strong',
              )}
            >
              <Icon size={14} strokeWidth={1.75} />
            </button>
          );
        })}
      </div>

      {/* X 軸に使う列の選択。未選択時は value を空文字にし、null として扱う。 */}
      <Field label={xLabel}>
        <Dropdown<string>
          value={config.xIndex === null ? '' : String(config.xIndex)}
          options={xs.map((c) => ({ value: String(c.index), label: c.name, hint: c.type }))}
          onChange={(v) => patch({ xIndex: v === '' ? null : Number(v) })}
          ariaLabel="X axis column"
          className="h-7 min-w-[7.5rem] text-xs"
        />
      </Field>

      {/* Y 軸に使う列の選択。円グラフ/散布図は単一選択（Dropdown）、それ以外は複数選択（MultiSelect）。 */}
      <Field label={yLabel}>
        {config.type === 'pie' || config.type === 'scatter' ? (
          <Dropdown<string>
            value={config.yIndices[0] === undefined ? '' : String(config.yIndices[0])}
            options={ys.map((c) => ({ value: String(c.index), label: c.name, hint: c.type }))}
            onChange={(v) => patch({ yIndices: v === '' ? [] : [Number(v)] })}
            ariaLabel="Y axis column"
            className="h-7 min-w-[7.5rem] text-xs"
          />
        ) : (
          <MultiSelect
            options={ys}
            selected={config.yIndices}
            onChange={(yIndices) => patch({ yIndices })}
          />
        )}
      </Field>

      {/* 散布図のときだけ、グループ化列とバブルサイズ列の選択肢を追加表示する。 */}
      {config.type === 'scatter' && (
        <>
          {/* 散布図の点を色分けするグループ化列（未選択可）。 */}
          <Field label="Group">
            <Dropdown<string>
              value={config.groupIndex == null ? '' : String(config.groupIndex)}
              options={[
                { value: '', label: 'None' },
                ...groups.map((c) => ({ value: String(c.index), label: c.name, hint: c.type })),
              ]}
              onChange={(v) => patch({ groupIndex: v === '' ? null : Number(v) })}
              ariaLabel="Scatter grouping column"
              className="h-7 min-w-[6.5rem] text-xs"
            />
          </Field>
          {/* 散布図の点の大きさを決める数値列（未選択可）。 */}
          <Field label="Size">
            <Dropdown<string>
              value={config.sizeIndex == null ? '' : String(config.sizeIndex)}
              options={[
                { value: '', label: 'None' },
                ...ys.map((c) => ({ value: String(c.index), label: c.name, hint: c.type })),
              ]}
              onChange={(v) => patch({ sizeIndex: v === '' ? null : Number(v) })}
              ariaLabel="Scatter point-size column"
              className="h-7 min-w-[6.5rem] text-xs"
            />
          </Field>
        </>
      )}

      {/* 並び替え順（なし、昇順、降順）の選択。 */}
      <Field label="Sort" icon={ArrowDownNarrowWide}>
        <Dropdown<SortOrder>
          value={config.sort}
          options={[
            { value: 'none', label: 'None' },
            { value: 'asc', label: 'Ascending' },
            { value: 'desc', label: 'Descending' },
          ]}
          onChange={(sort) => patch({ sort })}
          ariaLabel="Sort order"
          className="h-7 min-w-[6rem] text-xs"
        />
      </Field>

      {/* 表示する行数の上限。'all' を選ぶとロード済みの全行を対象にする。 */}
      <Field label="Limit">
        <Dropdown<string>
          value={String(config.limit)}
          options={[
            { value: '5', label: '5' },
            { value: '10', label: '10' },
            { value: '25', label: '25' },
            { value: '50', label: '50' },
            { value: '100', label: '100' },
            { value: 'all', label: 'All loaded' },
          ]}
          onChange={(v) => patch({ limit: (v === 'all' ? 'all' : Number(v)) as LimitOption })}
          ariaLabel="Row limit"
          className="h-7 min-w-[5.5rem] text-xs"
        />
      </Field>
    </div>
  );
}

/**
 * ラベル付きのフィールドラッパー。アイコン付きの小さなラベルと、任意のコントロール
 * （Dropdown や MultiSelect など）を縦に並べて表示する共通レイアウト。
 *
 * @param label - フィールドの見出し文言。
 * @param icon - ラベルの左に表示する任意のアイコン。
 * @param children - ラベルの下に表示する実際の入力コントロール。
 */
function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
        {Icon && <Icon size={12} strokeWidth={1.75} />}
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * A compact multi-select popover for picking several numeric Y measures.
 * 複数の数値列（Y 軸の測定値）を選択できる、コンパクトなポップオーバー式マルチセレクト。
 *
 * @param options - 選択肢として表示する列情報の一覧。
 * @param selected - 現在選択されている列インデックスの配列。
 * @param onChange - 選択内容が変わったときに、新しい選択インデックス配列を渡して呼ばれる。
 */
function MultiSelect({
  options,
  selected,
  onChange,
}: {
  options: ColumnInfo[];
  selected: number[];
  onChange: (next: number[]) => void;
}) {
  // open: ポップオーバー（選択肢一覧）が開いているかどうか。
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // ポップオーバーが開いている間、コンポーネント外側をクリックしたら自動的に閉じる。
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // 指定した列インデックスの選択状態をトグルする。
  const toggle = (index: number) => {
    const next = selected.includes(index)
      ? selected.filter((i) => i !== index)
      : [...selected, index];
    // Keep at least one measure selected.
    // 最低 1 つは選択状態を維持する（全解除になる場合は変更を無視する）。
    onChange(next.length === 0 ? selected : next);
  };

  // 現在選択されている列の表示名一覧。
  const selectedNames = options.filter((c) => selected.includes(c.index)).map((c) => c.name);
  // ボタンに表示する要約文言: 未選択なら「Select…」、2 件以下なら列名を列挙、
  // それ以上なら件数のみを表示する。
  const summary =
    selectedNames.length === 0
      ? 'Select…'
      : selectedNames.length <= 2
        ? selectedNames.join(', ')
        : `${selectedNames.length} columns`;

  return (
    <div ref={rootRef} className="relative inline-flex">
      {/* トリガーボタン: クリックでポップオーバーの開閉を切り替える。 */}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Y axis columns"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-7 min-w-[8rem] items-center gap-1.5 rounded-md border border-border-base bg-surface-raised px-2.5 text-xs text-ink-base',
          'hover:bg-surface-sunken',
          open && 'border-accent ring-1 ring-accent/30',
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      {/* ポップオーバー本体: 開いているときだけ選択肢一覧を表示する。 */}
      {open && (
        <ul
          role="listbox"
          aria-multiselectable
          className="absolute top-full left-0 z-50 mt-1 max-h-72 min-w-full overflow-auto rounded-md border border-border-strong bg-surface-overlay p-1 shadow-lg animate-[fadeIn_150ms_ease-out]"
        >
          {/* 各列を選択肢として一覧表示する。選択中の項目にはチェックマークを表示する。 */}
          {options.map((c) => {
            const isSelected = selected.includes(c.index);
            return (
              <li key={c.index}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggle(c.index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
                    isSelected
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink-base hover:bg-surface-sunken',
                  )}
                >
                  <Check
                    size={13}
                    strokeWidth={2}
                    className={cn('shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 font-mono text-[0.625rem] text-ink-subtle">
                    {c.type}
                  </span>
                </button>
              </li>
            );
          })}
          {/* 数値列が一つもない場合の空表示。 */}
          {options.length === 0 && (
            <li className="px-2 py-2 text-2xs text-ink-subtle">No numeric columns.</li>
          )}
        </ul>
      )}
    </div>
  );
}

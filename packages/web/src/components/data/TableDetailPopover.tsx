import { useEffect } from 'react';
import { AlertCircle, FilePlus2, Table2, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchTableDetail,
  fetchTableSample,
  metadataQueryKeys,
  META_STALE_MS,
} from '../../api/metadata';
import { addSqlCellWithSource } from '../../notebook';
import { selectTemplate, type EditorContext } from './tableName';
import { Spinner } from '../common/Spinner';
import { IconButton } from '../common/IconButton';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';

/**
 * Table detail popover (design.md §5: カラム一覧 + 型 + コメント + サンプル 10 行).
 * Columns come from the (often already cached) table detail; the sample rows are
 * fetched lazily — only when the popover opens — via `GET .../sample`. A
 * "SELECT 雛形を新規セルへ" button adds a `SELECT col1, col2 … FROM t LIMIT 100`
 * cell. Rendered as a centred floating card with a scrim (the sidebar is too
 * narrow to host it inline).
 */

/*
 * このファイルの責務:
 * SchemaTree のテーブル行にある情報アイコンから開かれる、テーブル詳細ポップオーバー。
 * カラム一覧（型、コメント）とサンプル10行を1つのモーダルに表示し、そこから
 * 新規 SQL セルへ SELECT 雛形を追加できる。カラム一覧はツリー展開時に既にキャッシュ
 * されていることが多い一方、サンプル行はこのポップオーバーが開いている間だけ
 * 遅延取得される（重く、大きい可能性があるため、キャッシュ期間も短めにしている）。
 * 画面全体を覆うスクリム付きの中央フローティングカードとして描画される
 * （サイドバーはこの内容をインラインで表示するには幅が足りないため）。
 */

/** ポップオーバーの表示対象となるテーブル/ビューの識別情報。 */
export interface TableTarget {
  /** 所属する catalog 名。 */
  catalog: string;
  /** 所属する schema 名。 */
  schema: string;
  /** テーブル（またはビュー）名。 */
  name: string;
  /** メタデータ上の種別（'VIEW' ならビュー、それ以外はテーブル扱い）。 */
  type?: string;
}

/**
 * テーブル詳細ポップオーバー本体。カラム一覧、コメント、サンプル10行を表示し、
 * SELECT 雛形を新規セルへ追加するボタンを提供する。
 * @param target 表示対象のテーブル（catalog/schema/name/type）。
 * @param context 現在のエディタコンテキスト（SELECT 雛形の相対テーブル名判定に使用）。
 * @param onClose ポップオーバーを閉じる際に呼ばれるコールバック（背景クリック、×ボタン、Escape キーで発火）。
 */
export function TableDetailPopover({
  target,
  context,
  datasourceId,
  onClose,
}: {
  target: TableTarget;
  context: EditorContext;
  datasourceId: string;
  onClose: () => void;
}) {
  // 表示対象テーブルの識別情報を分解しておく（クエリキーの組み立てなどで繰り返し使う）。
  const { catalog, schema, name } = target;

  // テーブル詳細（カラム一覧、コメント）を取得する。SchemaTree 側で既に展開済みの
  // テーブルであれば TanStack Query のキャッシュがヒットし、即座に表示される。
  const detail = useQuery({
    queryKey: metadataQueryKeys.table(datasourceId, catalog, schema, name),
    queryFn: () => fetchTableDetail(datasourceId, catalog, schema, name),
    staleTime: META_STALE_MS,
  });

  // Sample is fetched only while the popover is mounted (design.md §5: 開いた時
  // のみ fetch). It can be slow / large, so a shorter cache window is fine.
  // サンプル行はこのコンポーネントがマウントされている間だけ取得する
  // （このポップオーバーを開いたときにだけ発火する遅延取得）。
  const sample = useQuery({
    queryKey: metadataQueryKeys.sample(datasourceId, catalog, schema, name),
    queryFn: () => fetchTableSample(datasourceId, catalog, schema, name),
    staleTime: 60_000,
  });

  // Escape キーでポップオーバーを閉じられるようにする副作用。マウント中のみ
  // キーイベントを監視し、アンマウント時にリスナーを確実に解除する。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 「SELECT template」ボタンのハンドラ。取得済みのカラム名一覧（未取得なら空配列で
  // '*' にフォールバック）から SELECT 雛形を組み立て、新規 SQL セルとして追加する。
  // セルの追加に成功したらトーストで通知し、ポップオーバーを閉じる。
  const onSelectTemplate = () => {
    const columns = detail.data?.columns.map((c) => c.name) ?? [];
    const sql = selectTemplate({ catalog, schema, name }, columns, context);
    const cellId = addSqlCellWithSource(sql);
    if (cellId) {
      toast.success('New SQL cell', `SELECT template for ${name} added.`);
      onClose();
    }
  };

  // サンプルテーブルのヘッダーに使うカラム一覧。サンプル取得結果に列情報があれば
  // それを優先し、なければテーブル詳細から得たカラム一覧にフォールバックする。
  const sampleColumns = sample.data?.columns ?? detail.data?.columns ?? [];

  return (
    <div
      className="fixed inset-0 z-[88] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${name} details`}
    >
      {/* 背景スクリム: クリックすると onClose が呼ばれてポップオーバーを閉じる。
          tabIndex={-1} でキーボードフォーカスの対象からは外している。 */}
      <button
        type="button"
        aria-label="Close details"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-strong/40 animate-[fadeIn_150ms_ease-out]"
      />
      {/* 画面中央に浮かぶカード本体。ヘッダー・（任意の）コメント行・
          スクロール可能なコンテンツ（Columns / Sample rows）で構成される。 */}
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-overlay shadow-lg animate-[fadeIn_150ms_ease-out]">
        {/* ヘッダー: 完全修飾テーブル名、種別バッジ（table/view）、SELECT 雛形追加
            ボタン、閉じるボタンを並べる。 */}
        <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <Table2 size={15} strokeWidth={1.75} className="text-ink-muted" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-ink-strong">
            {catalog}.{schema}.{name}
          </span>
          <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-2xs tracking-wide text-ink-muted uppercase">
            {target.type === 'VIEW' ? 'view' : 'table'}
          </span>
          <Button variant="default" size="sm" icon={FilePlus2} onClick={onSelectTemplate}>
            SELECT template
          </Button>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} tooltip={false} />
        </header>

        {/* テーブル自体のコメント（メタデータにコメントがある場合のみ表示）。 */}
        {detail.data?.comment && (
          <p className="border-b border-border-subtle px-4 py-2 text-xs text-ink-muted">
            {detail.data.comment}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {/* Columns */}
          {/* カラム一覧セクション: 読み込み中/エラー表示のあと、取得済みなら
              各カラムの名前、コメント、型を一覧表示する。 */}
          <section>
            <h3 className="sticky top-0 z-10 bg-surface-overlay px-4 pt-3 pb-1 text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
              Columns
            </h3>
            {detail.isPending && (
              <p className="flex items-center gap-2 px-4 py-3 font-mono text-2xs text-ink-subtle">
                <Spinner size={12} /> Loading columns…
              </p>
            )}
            {detail.isError && (
              <p className="flex items-center gap-1.5 px-4 py-3 font-mono text-2xs text-error">
                <AlertCircle size={12} /> Failed to load columns.
              </p>
            )}
            <ul className="px-2 pb-2">
              {/* カラムごとに1行描画: 名前、（あれば）コメント、型を横並びに表示する。 */}
              {detail.data?.columns.map((col) => (
                <li
                  key={col.name}
                  className="flex h-7 items-center gap-3 rounded-sm px-2 hover:bg-surface-sunken"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-base">
                    {col.name}
                  </span>
                  {col.comment && (
                    <span className="min-w-0 max-w-[40%] truncate text-2xs text-ink-subtle">
                      {col.comment}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-2xs text-ink-subtle">{col.type}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Sample rows */}
          {/* サンプル行セクション: 読み込み中/エラー/0件/データありの4状態を出し分ける。
              データがある場合のみ、カラム一覧をヘッダーに使ったテーブルを描画する。 */}
          <section className="border-t border-border-subtle">
            <h3 className="sticky top-0 z-10 bg-surface-overlay px-4 pt-3 pb-1 text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
              Sample · 10 rows
            </h3>
            {sample.isPending && (
              <p className="flex items-center gap-2 px-4 py-3 font-mono text-2xs text-ink-subtle">
                <Spinner size={12} /> Loading sample…
              </p>
            )}
            {sample.isError && (
              <p className="flex items-center gap-1.5 px-4 py-3 font-mono text-2xs text-error">
                <AlertCircle size={12} /> Failed to load sample rows.
              </p>
            )}
            {sample.data && sample.data.rows.length === 0 && (
              <p className="px-4 py-3 font-mono text-2xs text-ink-subtle italic">No rows.</p>
            )}
            {sample.data && sample.data.rows.length > 0 && (
              <div className="overflow-auto px-2 pb-3">
                <table className="w-full border-collapse font-mono text-2xs">
                  <thead>
                    <tr>
                      {/* ヘッダー行: サンプル行の列情報（sampleColumns）からカラム名を描画。 */}
                      {sampleColumns.map((c) => (
                        <th
                          key={c.name}
                          className="border-b border-border-subtle px-2 py-1 text-left font-medium whitespace-nowrap text-ink-muted"
                        >
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* データ行: 行ごと、セルごとに map で描画し、null 値は斜体の
                        'null' 表記にして通常の値と区別する。 */}
                    {sample.data.rows.map((row, ri) => (
                      <tr key={ri} className="hover:bg-surface-sunken">
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            className={cn(
                              'border-b border-border-subtle/60 px-2 py-1 whitespace-nowrap',
                              cell === null ? 'text-ink-subtle italic' : 'text-ink-base',
                            )}
                          >
                            {cell === null ? 'null' : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

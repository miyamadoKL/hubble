/**
 * TopBar に置かれる catalog.schema コンテキストの選択 UI。
 * ボタンをクリックすると検索付きの2ペイン（catalog / schema）ポップオーバーが開き、
 * 「最近使った」候補からのワンクリック復元にも対応する。選択結果は `onChange` で
 * 呼び出し元（AppShell）に伝え、呼び出し元が現在のノートブックと最近使った履歴に保存する。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock, Database, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchCatalogs, fetchSchemas, metadataQueryKeys, META_STALE_MS } from '../../api/metadata';
import { readRecentContexts, type ContextValue } from '../../notebook';
import { Spinner } from '../common/Spinner';
import { cn } from '../../utils/cn';

/**
 * ポップオーバーの外側クリックと Escape キーで `onClose` を呼ぶ共通フック。
 * `open` が false の間はイベントリスナーを登録しない。
 *
 * @param ref - ポップオーバーのルート要素への ref。この要素の外側クリックを検知する。
 * @param onClose - 外側クリックまたは Escape 押下時に呼ばれるコールバック。
 * @param open - ポップオーバーが開いているかどうか。
 */
function useOutsideClose(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  open: boolean,
) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, onClose, open]);
}

/**
 * catalog.schema コンテキストセレクター本体。
 *
 * @param catalog - 現在選択されている catalog 名（未選択なら空文字）。
 * @param schema - 現在選択されている schema 名（未選択なら空文字）。
 * @param onChange - catalog/schema の選択が確定したときに呼ばれるコールバック。
 * @param className - ルート要素へ追加する Tailwind クラス。
 */
export function ContextSelector({
  datasourceId,
  catalog,
  schema,
  onChange,
  className,
}: {
  datasourceId?: string;
  catalog: string;
  schema: string;
  onChange: (next: { catalog: string; schema: string }) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // 選択中に右ペインへ表示する schema がどの catalog のものか（ホバー中のプレビュー値）。
  const [pickCatalog, setPickCatalog] = useState(catalog);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 「最近使った」候補一覧。ポップオーバーを開くたびに localStorage から読み直す。
  const [recents, setRecents] = useState<ContextValue[]>([]);

  useOutsideClose(rootRef, () => setOpen(false), open);

  // catalog 一覧はポップオーバーを開いたときだけ取得する（閉じている間は無駄なリクエストをしない）。
  const catalogs = useQuery({
    queryKey: datasourceId ? metadataQueryKeys.catalogs(datasourceId) : ['metadata', 'noop'],
    queryFn: () => fetchCatalogs(datasourceId!),
    staleTime: META_STALE_MS,
    enabled: open && Boolean(datasourceId),
  });

  // schema 一覧は「開いている」かつ「対象 catalog が選ばれている」ときだけ取得する。
  // pickCatalog が変わるたびに右ペインの内容が切り替わる。
  const schemas = useQuery({
    queryKey:
      datasourceId && pickCatalog
        ? metadataQueryKeys.schemas(datasourceId, pickCatalog)
        : ['metadata', 'noop'],
    queryFn: () => fetchSchemas(datasourceId!, pickCatalog),
    staleTime: META_STALE_MS,
    enabled: open && Boolean(datasourceId) && Boolean(pickCatalog),
  });

  // ポップオーバーが開いたら検索欄へフォーカスする（DOM への副作用のみで setState は
  // 行わないため、連鎖的な再レンダーを起こす禁則には該当しない）。
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /** ポップオーバーを開き、現在の props から一時的な状態（最近使った候補、pickCatalog、検索語）を初期化する。 */
  const openPopover = () => {
    setRecents(datasourceId ? readRecentContexts(datasourceId) : []);
    setPickCatalog(catalog);
    setSearch('');
    setOpen(true);
  };

  // 検索欄の入力値をクライアント側フィルタ用に正規化（前後空白除去 + 小文字化）。
  const needle = search.trim().toLowerCase();
  // catalog / schema それぞれ取得済みの一覧を needle で部分一致フィルタする（サーバー再取得はしない）。
  const catalogItems = useMemo(
    () => (catalogs.data?.items ?? []).filter((c) => c.name.toLowerCase().includes(needle)),
    [catalogs.data, needle],
  );
  const schemaItems = useMemo(
    () => (schemas.data?.items ?? []).filter((s) => s.name.toLowerCase().includes(needle)),
    [schemas.data, needle],
  );

  // catalog + schema の組み合わせを確定させ、呼び出し元へ通知してポップオーバーを閉じる。
  const choose = (nextCatalog: string, nextSchema: string) => {
    onChange({ catalog: nextCatalog, schema: nextSchema });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {/* 現在の catalog.schema を表示するトリガーボタン。クリックでポップオーバーの開閉を切り替える。 */}
      <button
        type="button"
        aria-label="catalog.schema context"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md border bg-surface-raised px-2.5 text-sm transition-colors',
          open
            ? 'border-accent ring-1 ring-accent/30'
            : 'border-border-base hover:bg-surface-sunken',
        )}
      >
        <Database size={14} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
        <span className="font-mono text-xs text-ink-base">
          {catalog || '—'}
          <span className="text-ink-subtle">.</span>
          {schema || '—'}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>

      {/* 検索付き2ペインのポップオーバー本体。open のときのみマウントする。 */}
      {open && (
        <div
          role="dialog"
          aria-label="Select context"
          className="absolute right-0 z-50 mt-1 w-80 overflow-hidden rounded-md border border-border-strong bg-surface-overlay shadow-lg animate-[fadeIn_150ms_ease-out]"
        >
          {/* catalog/schema を横断してフィルタする検索入力欄。 */}
          <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-2">
            <Search size={14} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter catalogs / schemas…"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink-base placeholder:text-ink-subtle focus:outline-none"
            />
          </div>

          {/* 「最近使った」セクションは検索中（needle あり）は非表示にし、フィルタ結果と競合させない。 */}
          {recents.length > 0 && !needle && (
            <div className="border-b border-border-subtle px-2 py-1.5">
              <p className="mb-1 px-1 text-2xs font-semibold tracking-[0.12em] text-ink-subtle uppercase">
                Recent
              </p>
              <div className="flex flex-col">
                {recents.map((r) => (
                  <button
                    key={`${r.catalog}.${r.schema}`}
                    type="button"
                    onClick={() => choose(r.catalog, r.schema)}
                    className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left font-mono text-xs text-ink-base hover:bg-surface-sunken"
                  >
                    <Clock size={12} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
                    {r.catalog}
                    <span className="text-ink-subtle">.</span>
                    {r.schema}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid h-56 grid-cols-2">
            {/* 左ペイン: catalog 一覧。読み込み中/エラー/一覧をそれぞれ出し分ける。 */}
            <div className="overflow-auto border-r border-border-subtle py-1">
              <p className="px-2.5 pb-1 text-2xs font-semibold tracking-[0.12em] text-ink-subtle uppercase">
                Catalog
              </p>
              {catalogs.isPending && (
                <p className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-2xs text-ink-subtle">
                  <Spinner size={11} /> Loading…
                </p>
              )}
              {catalogs.isError && (
                <p className="px-2.5 py-1 font-mono text-2xs text-error">Failed to load.</p>
              )}
              {catalogItems.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  // ホバーだけで右ペインの schema 一覧をプレビュー切り替えする（クリックは不要）。
                  onMouseEnter={() => setPickCatalog(c.name)}
                  onClick={() => setPickCatalog(c.name)}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-2.5 py-1 text-left font-mono text-xs',
                    c.name === pickCatalog
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink-base hover:bg-surface-sunken',
                  )}
                >
                  <Database size={12} strokeWidth={1.75} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                </button>
              ))}
            </div>

            {/* 右ペイン: 左でホバー/選択中の catalog に属する schema 一覧。 */}
            <div className="overflow-auto py-1">
              <p className="px-2.5 pb-1 text-2xs font-semibold tracking-[0.12em] text-ink-subtle uppercase">
                Schema
              </p>
              {schemas.isPending && (
                <p className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-2xs text-ink-subtle">
                  <Spinner size={11} /> Loading…
                </p>
              )}
              {schemas.isError && (
                <p className="px-2.5 py-1 font-mono text-2xs text-error">Failed to load.</p>
              )}
              {schemas.data && schemaItems.length === 0 && (
                <p className="px-2.5 py-1 font-mono text-2xs text-ink-subtle italic">
                  {needle ? 'No matches' : 'No schemas'}
                </p>
              )}
              {schemaItems.map((s) => {
                // 「現在確定しているコンテキストと同じ schema か」で選択状態を示す
                // （pickCatalog はホバー中のプレビューであり、確定値とは別物）。
                const selected = pickCatalog === catalog && s.name === schema;
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => choose(pickCatalog, s.name)}
                    className={cn(
                      'w-full px-2.5 py-1 text-left font-mono text-xs',
                      selected
                        ? 'bg-accent-soft text-accent'
                        : 'text-ink-base hover:bg-surface-sunken',
                    )}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * コマンドパレット (Ctrl+K) コンポーネントを定義するモジュール。
 *
 * design.md §6 で定義されたコマンドパレット機能を実装する。コマンド一覧の
 * 検索と実行、サイドバーへのナビゲーション、ノートブックを開くための
 * サブモードなどをまとめて提供する。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookMarked,
  Code2,
  Database,
  FileCode2,
  FilePlus2,
  FileText,
  History,
  Keyboard,
  Moon,
  NotebookText,
  Play,
  Presentation,
  Save,
  Search,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useUiStore } from '../../stores/uiStore';
import { Kbd } from '../common/Kbd';
import { Spinner } from '../common/Spinner';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';
import { useNotebookStore, runAllCells, saveActiveNotebook } from '../../notebook';
import { listNotebooks, getNotebook } from '../../api/notebooks';
import { formatRelativeTime } from '../../utils/format';

/**
 * Command palette (design.md §6: Ctrl+K). P4b completes it: navigation entries
 * use `gotoSidebar` (switch tab + expand + focus its search), a "Open notebook…"
 * entry drops into a searchable notebook list, and the action set is organised as
 * a registry built from injected handlers so new actions are easy to add.
 *
 * The content is split into a freshly-mounted inner component so each open starts
 * with clean query/selection state (no reset-in-effect).
 *
 * コマンドパレットは design.md §6 (Ctrl+K) の完成形 (P4b) である。ナビゲーション
 * 系のエントリは `gotoSidebar` (タブ切り替え + 展開 + 検索欄へのフォーカス) を
 * 使い、「ノートブックを開く…」エントリは検索可能なノートブック一覧のサブ
 * モードに遷移する。アクション一覧は、注入されたハンドラーから組み立てられる
 * レジストリとして構成されており、新しいアクションを追加しやすくなっている。
 *
 * パレットの中身 (PaletteContent) は毎回新しくマウントされる内側の
 * コンポーネントとして分離されている。これにより、開くたびに検索クエリや
 * 選択状態がクリーンな初期値から始まる（effect 内でリセットする必要がない）。
 */

/** コマンドパレット上の1つのコマンドを表す内部型。 */
interface Command {
  /** コマンドを一意に識別する ID。 */
  id: string;
  /** パレット上に表示されるラベル文字列。 */
  label: string;
  /** コマンドの左側に表示するアイコン。 */
  icon: LucideIcon;
  /** コマンドが属するグループ名（表示上の分類）。 */
  group: string;
  /** 対応するキーボードショートカット（表示用）。省略可。 */
  shortcut?: string[];
  /** コマンドの選択と実行が行われた際に呼ばれる処理。 */
  run: () => void;
}

/** パレットの表示モード。通常のコマンド一覧か、ノートブックを開くサブモードか。 */
type PaletteMode = 'commands' | 'open-notebook';

/**
 * Build the command registry from injected handlers (design.md §6 registry).
 *
 * 注入されたハンドラー群から、パレットに表示するコマンド一覧 (registry) を
 * 組み立てる (design.md §6 のコマンドレジストリ)。呼び出し元のコンポーネント
 * が保持する状態やストアの操作関数を deps として受け取り、コマンドオブジェクトの
 * 配列に変換する。
 *
 * @param deps コマンド構築に必要な依存関係一式。
 * @param deps.context クエリ実行時に使うカタログ/スキーマのコンテキスト。
 * @param deps.defaultLimit 「全セル実行」などで使うデフォルトの行数上限。
 * @param deps.theme 現在のテーマ（ライト/ダーク）。テーマ切り替えコマンドの
 *   ラベルとアイコンの出し分けに使う。
 * @param deps.presentationMode 現在プレゼンテーションモードかどうか。
 *   対応するコマンドのラベル出し分けに使う。
 * @param deps.gotoSidebar 指定タブへ切り替えてサイドバーを表示する処理。
 * @param deps.toggleTheme テーマを切り替える処理。
 * @param deps.togglePresentation プレゼンテーションモードを切り替える処理。
 * @param deps.openShortcutsHelp キーボードショートカットのヘルプを開く処理。
 * @param deps.requestSave 保存 / 名前を付けて保存を要求する処理。
 * @param deps.enterOpenNotebook 「ノートブックを開く」サブモードに遷移する処理。
 * @returns パレットに表示するコマンドの配列。
 */
function buildCommands(deps: {
  context: { catalog: string; schema: string };
  defaultLimit: number;
  theme: 'light' | 'dark';
  presentationMode: boolean;
  gotoSidebar: (tab: 'data' | 'notebooks' | 'saved' | 'history') => void;
  toggleTheme: () => void;
  togglePresentation: () => void;
  openShortcutsHelp: () => void;
  requestSave: (mode: 'save' | 'saveAs') => void;
  enterOpenNotebook: () => void;
}): Command[] {
  // deps から各依存関数と状態を分割代入で取り出す。
  const {
    context,
    defaultLimit,
    theme,
    presentationMode,
    gotoSidebar,
    toggleTheme,
    togglePresentation,
    openShortcutsHelp,
    requestSave,
    enterOpenNotebook,
  } = deps;

  // アクティブなノートブックの末尾に新しいセル（SQL または Markdown）を
  // 追加するヘルパー。アクティブなノートブックが存在しない場合は、
  // トーストで案内を出して何もしない。
  const addCellToActive = (kind: 'sql' | 'markdown') => {
    const store = useNotebookStore.getState();
    const id = store.activeId;
    if (!id) {
      // 開いているノートブックがなければ、先に作成するよう促して終了する。
      toast.info('No notebook open', 'Create a notebook first.');
      return;
    }
    store.addCell(id, kind, 'end');
    toast.info(kind === 'sql' ? 'New SQL cell' : 'New Markdown cell');
  };

  // コマンドレジストリ本体。各要素が1つのコマンドパレット項目に対応する。
  return [
    // 「Query」グループ: 現在のノートブックの全セルを実行する。
    {
      id: 'run-all',
      label: 'Run all cells',
      icon: Play,
      group: 'Query',
      run: () => void runAllCells(context, defaultLimit),
    },
    // 「Notebook」グループ: 保存、新規作成、開く、セル追加などノートブック操作系。
    {
      id: 'save',
      label: 'Save notebook',
      icon: Save,
      group: 'Notebook',
      shortcut: ['Ctrl', 'S'],
      run: () =>
        void saveActiveNotebook().then((r) => {
          if ('needsName' in r) requestSave('save');
        }),
    },
    {
      id: 'save-as',
      label: 'Save notebook as…',
      icon: Save,
      group: 'Notebook',
      run: () => requestSave('saveAs'),
    },
    {
      id: 'new-notebook',
      label: 'New notebook',
      icon: FilePlus2,
      group: 'Notebook',
      run: () => useNotebookStore.getState().createBlankNotebook(),
    },
    {
      id: 'open-notebook',
      label: 'Open notebook…',
      icon: NotebookText,
      group: 'Notebook',
      run: enterOpenNotebook,
    },
    {
      id: 'new-sql',
      label: 'New SQL cell',
      icon: Code2,
      group: 'Notebook',
      run: () => addCellToActive('sql'),
    },
    {
      id: 'new-md',
      label: 'New Markdown cell',
      icon: FileText,
      group: 'Notebook',
      run: () => addCellToActive('markdown'),
    },
    // 「Navigate」グループ: サイドバーの各タブへ切り替えるコマンド群。
    {
      id: 'goto-data',
      label: 'Go to Data browser',
      icon: Database,
      group: 'Navigate',
      run: () => gotoSidebar('data'),
    },
    {
      id: 'goto-saved',
      label: 'Go to Saved queries',
      icon: BookMarked,
      group: 'Navigate',
      run: () => gotoSidebar('saved'),
    },
    {
      id: 'goto-history',
      label: 'Go to History',
      icon: History,
      group: 'Navigate',
      run: () => gotoSidebar('history'),
    },
    {
      id: 'goto-notebooks',
      label: 'Go to Notebooks',
      icon: NotebookText,
      group: 'Navigate',
      run: () => gotoSidebar('notebooks'),
    },
    // 「Appearance」グループ: テーマ切り替えとプレゼンテーションモード切り替え。
    // ラベルとアイコンは現在の状態 (theme / presentationMode) に応じて動的に切り替える。
    {
      id: 'theme',
      label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      group: 'Appearance',
      shortcut: ['Ctrl', 'Alt', 'T'],
      run: () => toggleTheme(),
    },
    {
      id: 'presentation',
      label: presentationMode ? 'Exit presentation mode' : 'Enter presentation mode',
      icon: Presentation,
      group: 'Appearance',
      shortcut: ['Ctrl', 'Shift', 'P'],
      run: () => togglePresentation(),
    },
    // 「Help」グループ: キーボードショートカット一覧を開く。
    {
      id: 'shortcuts-help',
      label: 'Keyboard shortcuts',
      icon: Keyboard,
      group: 'Help',
      run: () => openShortcutsHelp(),
    },
  ];
}

/**
 * コマンドパレットの中身（検索欄、コマンド一覧、ノートブック検索一覧）を
 * 描画する内部コンポーネント。パレットが開かれるたびに新しくマウントされる
 * ことを前提としており、内部状態（検索クエリ、選択中インデックス、
 * モード）は常にクリーンな初期値から始まる。
 *
 * @param onClose パレットを閉じる際に呼び出すコールバック。
 * @param context コマンド実行（全セル実行など）に使うカタログ/スキーマの
 *   コンテキスト。
 * @param defaultLimit 「全セル実行」で使うデフォルトの行数上限。
 */
function PaletteContent({
  onClose,
  context,
  defaultLimit,
}: {
  onClose: () => void;
  context: { catalog: string; schema: string };
  defaultLimit: number;
}) {
  // UI ストアから、コマンド実行に必要な状態と操作関数をそれぞれ購読する。
  const gotoSidebar = useUiStore((s) => s.gotoSidebar);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const togglePresentation = useUiStore((s) => s.togglePresentation);
  const setShortcutsHelpOpen = useUiStore((s) => s.setShortcutsHelpOpen);
  const requestSave = useUiStore((s) => s.requestSave);
  const theme = useUiStore((s) => s.theme);
  const presentationMode = useUiStore((s) => s.presentationMode);

  // mode: 「commands」(通常のコマンド一覧) か「open-notebook」(ノートブック検索) か。
  const [mode, setMode] = useState<PaletteMode>('commands');
  // query: 検索欄に入力されているテキスト。
  const [query, setQuery] = useState('');
  // activeIndex: キーボード操作 (↑↓) やマウスホバーで選択中の項目のインデックス。
  const [activeIndex, setActiveIndex] = useState(0);
  // 検索入力欄の DOM 要素への参照（マウント時にフォーカスするために使用）。
  const inputRef = useRef<HTMLInputElement>(null);

  // マウント時に検索入力欄へ自動フォーカスする（コンポーネントは開くたびに
  // 再マウントされるため、このロジックは開くたびに毎回実行される）。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 注入されたハンドラー・状態から、コマンド一覧を組み立てる。
  // 依存する値（テーマやプレゼンテーションモードなど）が変わった場合のみ再計算する。
  const commands = useMemo(
    () =>
      buildCommands({
        context,
        defaultLimit,
        theme,
        presentationMode,
        gotoSidebar,
        toggleTheme,
        togglePresentation,
        openShortcutsHelp: () => setShortcutsHelpOpen(true),
        requestSave,
        enterOpenNotebook: () => {
          // 「ノートブックを開く…」コマンドの実行時: サブモードに切り替え、
          // 検索クエリと選択位置をリセットする。
          setMode('open-notebook');
          setQuery('');
          setActiveIndex(0);
        },
      }),
    [
      context,
      defaultLimit,
      theme,
      presentationMode,
      gotoSidebar,
      toggleTheme,
      togglePresentation,
      setShortcutsHelpOpen,
      requestSave,
    ],
  );

  // 検索クエリでコマンド一覧を絞り込む。クエリが空の場合は全件を返す。
  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(needle));
  }, [commands, query]);

  // Notebook list for "Open notebook…" mode (server search, only while active).
  // 「ノートブックを開く」モードのときのみ有効化される、サーバー側検索によるノートブック一覧取得。
  const notebooks = useQuery({
    queryKey: ['notebooks', 'list', query.trim()],
    queryFn: () => listNotebooks(query.trim() || undefined),
    enabled: mode === 'open-notebook',
  });

  // 指定 ID のノートブックを開く。すでに開いていればそれをアクティブにするだけ、
  // まだ開いていなければサーバーから取得してからストアに追加する。
  const openNotebook = async (id: string) => {
    const store = useNotebookStore.getState();
    if (store.open[id]) {
      // すでに開いている場合はアクティブなノートブックとして切り替えるだけ。
      store.setActive(id);
    } else {
      try {
        // 未取得の場合はサーバーから取得し、ドラフトではない状態でストアに開く。
        const nb = await getNotebook(id);
        store.openNotebook(nb, { draft: false, activate: true });
      } catch {
        // 取得に失敗した場合はエラートーストを表示する。
        toast.error('Open failed', 'That notebook could not be loaded.');
      }
    }
    // 成否にかかわらず、ノートブックを開こうとした操作の後はパレットを閉じる。
    onClose();
  };

  // 現在のモードに応じたリスト件数と、範囲外に出ないよう補正した選択インデックスを計算する。
  const notebookItems = notebooks.data ?? [];
  const itemCount = mode === 'commands' ? filteredCommands.length : notebookItems.length;
  const safeIndex = Math.min(activeIndex, Math.max(0, itemCount - 1));

  // 検索クエリの変更ハンドラー。クエリが変わったら選択位置は先頭に戻す。
  function onQueryChange(value: string) {
    setQuery(value);
    setActiveIndex(0);
  }

  // パレット全体のキーボード操作を処理するハンドラー（Esc / Backspace / 矢印キー / Enter）。
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      // Esc: サブモード中ならコマンド一覧モードに戻るだけ、通常モードならパレットを閉じる。
      if (mode === 'open-notebook') {
        setMode('commands');
        setQuery('');
        setActiveIndex(0);
      } else {
        onClose();
      }
    } else if (e.key === 'Backspace' && mode === 'open-notebook' && query === '') {
      // Backspace: 検索欄が空の状態でノートブック検索モード中に押された場合、
      // コマンド一覧モードへ戻る（入力欄を消してからさらに戻る、という操作感）。
      setMode('commands');
    } else if (e.key === 'ArrowDown') {
      // ↓キー: 選択位置を1つ下に移動する（末尾を超えない）。
      e.preventDefault();
      setActiveIndex(Math.min(itemCount - 1, safeIndex + 1));
    } else if (e.key === 'ArrowUp') {
      // ↑キー: 選択位置を1つ上に移動する（先頭を下回らない）。
      e.preventDefault();
      setActiveIndex(Math.max(0, safeIndex - 1));
    } else if (e.key === 'Enter') {
      // Enter: 現在選択中の項目を実行する。モードによって挙動を分岐する。
      e.preventDefault();
      if (mode === 'commands') {
        const cmd = filteredCommands[safeIndex];
        if (cmd) {
          cmd.run();
          // Commands that switch to a sub-mode shouldn't close the palette.
          if (cmd.id !== 'open-notebook') onClose();
        }
      } else {
        // ノートブック検索モードでは、選択中のノートブックを開く。
        const nb = notebookItems[safeIndex];
        if (nb) void openNotebook(nb.id);
      }
    }
  }

  // 現在のモードに応じた検索欄のプレースホルダー文言。
  const placeholder =
    mode === 'open-notebook' ? 'Search notebooks…' : 'Type a command…';

  return (
    <div className="fixed inset-0 z-[95] flex items-start justify-center px-4 pt-[12vh]">
      {/* 背景を暗くするオーバーレイ。クリックするとパレットを閉じる。 */}
      <button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-strong/40 animate-[fadeIn_150ms_ease-out]"
      />
      {/* パレット本体のダイアログ。キーボード操作 (onKeyDown) をここで一括処理する。 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-lg border border-border-strong bg-surface-overlay shadow-lg animate-[slideUp_150ms_ease-out]"
        onKeyDown={onKeyDown}
      >
        {/* 検索入力欄。モードに応じてアイコンと「Open」バッジの表示を切り替える。 */}
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-3.5 py-3">
          {/* モードに応じたアイコン: ノートブック検索中は NotebookText、通常は検索アイコン。 */}
          {mode === 'open-notebook' ? (
            <NotebookText size={16} strokeWidth={1.75} className="shrink-0 text-accent" />
          ) : (
            <Search size={16} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
          )}
          {/* ノートブック検索モード中であることを示す「Open」バッジ。 */}
          {mode === 'open-notebook' && (
            <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">
              Open
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-base text-ink-strong placeholder:text-ink-subtle focus:outline-none"
          />
          <Kbd keys={['Esc']} />
        </div>

        {/* モードに応じてコマンド一覧かノートブック検索一覧のどちらかを描画する。 */}
        {mode === 'commands' ? (
          <ul className="max-h-80 overflow-auto py-1.5">
            {/* 検索結果が0件の場合の空状態表示。 */}
            {filteredCommands.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">No matching commands</li>
            )}
            {/* 絞り込み後のコマンド一覧をリスト表示する。選択中の項目はハイライトする。 */}
            {filteredCommands.map((cmd, i) => {
              const Icon = cmd.icon;
              const isActive = i === safeIndex;
              return (
                <li key={cmd.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => {
                      cmd.run();
                      if (cmd.id !== 'open-notebook') onClose();
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-accent-soft text-accent' : 'text-ink-base',
                    )}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.75}
                      className={cn('shrink-0', isActive ? 'text-accent' : 'text-ink-muted')}
                    />
                    <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                    <span className="shrink-0 text-2xs tracking-wide text-ink-subtle uppercase">
                      {cmd.group}
                    </span>
                    {cmd.shortcut && <Kbd keys={cmd.shortcut} />}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="max-h-80 overflow-auto py-1.5">
            {/* ノートブック一覧取得中のローディング表示。 */}
            {notebooks.isPending && (
              <li className="flex items-center justify-center gap-2 px-4 py-6 font-mono text-2xs text-ink-subtle">
                <Spinner size={14} /> Loading…
              </li>
            )}
            {/* 取得に失敗した場合のエラー表示。 */}
            {notebooks.isError && (
              <li className="px-4 py-6 text-center text-sm text-error">Couldn't load notebooks</li>
            )}
            {/* 取得は成功したが、該当するノートブックが0件だった場合の空状態表示。 */}
            {notebooks.data && notebookItems.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">No notebooks</li>
            )}
            {/* 検索結果のノートブック一覧をリスト表示する。選択中の項目はハイライトする。 */}
            {notebookItems.map((nb, i) => {
              const isActive = i === safeIndex;
              return (
                <li key={nb.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => void openNotebook(nb.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-accent-soft text-accent' : 'text-ink-base',
                    )}
                  >
                    <FileCode2
                      size={16}
                      strokeWidth={1.75}
                      className={cn('shrink-0', isActive ? 'text-accent' : 'text-ink-muted')}
                    />
                    <span className="min-w-0 flex-1 truncate">{nb.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-ink-subtle">
                      {formatRelativeTime(nb.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * コマンドパレットのエントリーポイントとなる公開コンポーネント。
 *
 * UI ストアの `paletteOpen` フラグを参照し、開いていなければ何も描画しない。
 * 開いている間だけ `PaletteContent` をマウントすることで、開くたびに検索
 * クエリと選択状態などの内部状態がリセットされた状態から始まるようにしている。
 *
 * @param context クエリ実行（コマンドの「全セル実行」など）に使う
 *   カタログ/スキーマのコンテキスト。
 * @param defaultLimit 「全セル実行」で使うデフォルトの行数上限。
 */
export function CommandPalette({
  context,
  defaultLimit,
}: {
  context: { catalog: string; schema: string };
  defaultLimit: number;
}) {
  // パレットが開いているかどうかを UI ストアから購読する。
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  // 閉じている場合は何も描画しない。
  if (!open) return null;
  // 開いている場合のみ PaletteContent をマウントする。
  return (
    <PaletteContent onClose={() => setOpen(false)} context={context} defaultLimit={defaultLimit} />
  );
}

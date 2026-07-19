/**
 * キーボードショートカット一覧を表示するモーダルを提供するモジュール。
 * コマンドパレットから開かれ、アプリ全体で共有されているショートカット
 * レジストリ (`SHORTCUTS`) を単一の情報源として一覧を描画する。
 */
import { Modal } from './Modal';
import { Kbd } from './Kbd';
import { SHORTCUTS, type ShortcutId } from '../../hooks/shortcuts';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { layoutMessages } from '../../i18n/messages/layout';

/** ShortcutsHelp 内で使う辞書の合成。共通文言（Keyboard shortcuts/Format SQL 等）+ layout 固有文言。 */
const shortcutsHelpDict = { ...commonMessages, ...layoutMessages } as const;

// ShortcutsHelp が実際に使う辞書キーだけのリテラル union。`keyof typeof
// shortcutsHelpDict`（辞書全体のキー）のままだと、`{name}` 等のプレースホルダーを
// 持つ他エントリの型が union に混ざり、`t()` の引数要求が不定になって
// typecheck が通らないため、プレースホルダーを持たないこれらのキーだけに絞る
// （Sidebar.tsx の SidebarLabelKey と同じ理由）。
type ShortcutLabelKey =
  | 'shortcutRunActiveCell'
  | 'shortcutSaveDocument'
  | 'formatSqlActionLabel'
  | 'shortcutFormatSqlAlt'
  | 'commandPaletteLabel'
  | 'shortcutToggleTheme'
  | 'shortcutTogglePresentation';

// SHORTCUTS レジストリ（hooks/shortcuts.ts）の各行は英語の `label` を1つの正として
// 持つが、翻訳辞書は layout.ts 側に置く方針のため、行の安定 ID（`ShortcutSpec.id`）で
// 辞書キーへマッピングする。`Record<ShortcutId, ...>` により、SHORTCUTS へ要素を
// 追加したのに対応キーを追加し忘れる、または削除したのに対応キーが残ったままになる、
// のどちらも typecheck の時点で検出できる（レビュー指摘: 配列順インデックスでの対応は
// 並べ替えや追加を検出できなかったため、安定 ID ベースへ変更した）。
const SHORTCUT_LABEL_KEYS: Record<ShortcutId, ShortcutLabelKey> = {
  run: 'shortcutRunActiveCell',
  save: 'shortcutSaveDocument',
  formatPrimary: 'formatSqlActionLabel',
  formatAlternate: 'shortcutFormatSqlAlt',
  palette: 'commandPaletteLabel',
  theme: 'shortcutToggleTheme',
  presentation: 'shortcutTogglePresentation',
};

/**
 * コマンドパレットから開かれる「キーボードショートカット」参照用モーダル。
 * ショートカットの定義（キーとラベル）を `SHORTCUTS` レジストリ一箇所に
 * 集約しているため、ここでの表示、コマンドパレット、実際のキー入力
 * ディスパッチャの間でショートカット情報がずれることがない
 * （表示文言の翻訳キーだけは `SHORTCUT_LABEL_KEYS` で行の安定 ID に対応付ける）。
 *
 * @param open - モーダルの開閉状態。true のとき表示される。
 * @param onClose - モーダルを閉じる際に呼び出されるコールバック。
 */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(shortcutsHelpDict);
  return (
    <Modal open={open} onClose={onClose} title={t('keyboardShortcutsTitle')} className="max-w-md">
      {/* SHORTCUTS レジストリの内容をそのまま一覧化し、各行にラベルとキー表示 (Kbd) を並べる */}
      <ul className="divide-y divide-border-subtle">
        {SHORTCUTS.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-4 py-2">
            <span className="text-sm text-ink-base">{t(SHORTCUT_LABEL_KEYS[s.id])}</span>
            <Kbd keys={s.keys} />
          </li>
        ))}
      </ul>
      {/* macOS でのキー表記に関する補足説明と、エディタ内でも同じショートカットが使える旨の注記 */}
      <p className="mt-3 text-2xs text-ink-subtle">{t('macShortcutNote')}</p>
    </Modal>
  );
}

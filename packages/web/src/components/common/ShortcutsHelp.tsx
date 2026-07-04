/**
 * キーボードショートカット一覧を表示するモーダルを提供するモジュール。
 * コマンドパレットから開かれ、アプリ全体で共有されているショートカット
 * レジストリ (`SHORTCUTS`) を単一の情報源として一覧を描画する。
 */
import { Modal } from './Modal';
import { Kbd } from './Kbd';
import { SHORTCUTS } from '../../hooks/shortcuts';

/**
 * "Keyboard shortcuts" reference modal. Opened from the command
 * palette; lists the canonical shortcut registry so the keys shown here, in the
 * palette, and the runtime dispatcher all come from one source (`SHORTCUTS`).
 *
 * コマンドパレットから開かれる「キーボードショートカット」参照用モーダル。
 * ショートカットの定義（キー・ラベル）を `SHORTCUTS` レジストリ一箇所に
 * 集約しているため、ここでの表示、コマンドパレット、実際のキー入力
 * ディスパッチャの間でショートカット情報がずれることがない。
 *
 * @param open - モーダルの開閉状態。true のとき表示される。
 * @param onClose - モーダルを閉じる際に呼び出されるコールバック。
 */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" className="max-w-md">
      {/* SHORTCUTS レジストリの内容をそのまま一覧化し、各行にラベルとキー表示 (Kbd) を並べる */}
      <ul className="divide-y divide-border-subtle">
        {SHORTCUTS.map((s) => (
          <li
            key={`${s.action}-${s.keys.join('+')}`}
            className="flex items-center justify-between gap-4 py-2"
          >
            <span className="text-sm text-ink-base">{s.label}</span>
            <Kbd keys={s.keys} />
          </li>
        ))}
      </ul>
      {/* macOS でのキー表記に関する補足説明と、エディタ内でも同じショートカットが使える旨の注記 */}
      <p className="mt-3 text-2xs text-ink-subtle">
        On macOS, ⌘ stands in for Ctrl. Run, format and save also work from inside the editor.
      </p>
    </Modal>
  );
}

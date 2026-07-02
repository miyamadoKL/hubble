/**
 * SaveNotebookModal.tsx
 *
 * ノートブックを保存する際に名前を入力させるモーダルダイアログ。
 * 「初回保存（ドラフトの保存）」と「名前を付けて保存（Save As）」の両方で
 * 共用され、呼び出し元が初期名を渡し、確定時に入力された名前を受け取る。
 */
import { useState } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';

/**
 * Notebook save dialog (design.md §5 管理: 名前入力モーダル + Save As). Used both
 * for the first save of a draft and for "Save As". The caller supplies the
 * initial name and receives the chosen name on confirm.
 */
/**
 * ノートブック保存用モーダルの本体。
 *
 * @param open - true のときモーダルを表示する。false のときは何も描画しない。
 * @param initialName - 入力欄の初期値として表示するノートブック名。
 * @param title - モーダルのタイトル文言（省略時は「Save notebook」）。
 * @param confirmLabel - 確定ボタンのラベル文言（省略時は「Save」）。
 * @param onClose - キャンセル/閉じる操作時に呼ばれる。
 * @param onConfirm - 確定（保存）操作時に、トリム済みの名前を渡して呼ばれる。
 */
export function SaveNotebookModal({
  open,
  initialName,
  title = 'Save notebook',
  confirmLabel = 'Save',
  onClose,
  onConfirm,
}: {
  open: boolean;
  initialName: string;
  title?: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  // name: 入力中のノートブック名。initialName を初期値として保持する。
  const [name, setName] = useState(initialName);

  // Reset the field each time the dialog opens by keying on `open` via a render
  // guard: when closed we don't render, so a fresh mount restores the initial.
  // open が false のときは何も描画しない。これにより、次に開いたときは
  // コンポーネントが再マウントされ、useState の初期値（initialName）に自然にリセットされる。
  if (!open) return null;

  // 確定処理: 名前をトリムし、空でなければ親へ通知する。
  const confirm = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Give the notebook a name to save it to the server."
      footer={
        // モーダルフッター: キャンセルボタンと確定ボタン。名前が空の場合は確定ボタンを無効化する。
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} disabled={!name.trim()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {/* ノートブック名の入力欄。Enter キーで確定できる。 */}
      <label className="flex flex-col gap-1.5">
        <span className="text-2xs font-semibold tracking-wide text-ink-muted uppercase">
          Notebook name
        </span>
        <input
          autoFocus
          value={name}
          aria-label="Notebook name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm();
          }}
          placeholder="Untitled notebook"
          className="w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none"
        />
      </label>
    </Modal>
  );
}

/**
 * VariablePanel.tsx
 *
 * ノートブックの SQL 内で使われている `${変数名}` 形式の変数を、ユーザーが
 * 値入力できる形で一覧表示するパネル。検出された型（text / number / date /
 * datetime-local / checkbox / select）に応じて適切な入力コントロールを描画し、
 * どの入力欄からでも Ctrl/Cmd+Enter でアクティブなセルを実行できるようにする。
 */
import { Variable as VariableIcon } from 'lucide-react';
import type { Variable } from '@hubble/contracts';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { notebookMessages } from '../../i18n/messages/notebook';

/**
 * Variable substitution panel (shown only when the
 * notebook's SQL defines `${…}` variables). Each variable renders a typed input
 * (text / number / date / datetime-local / checkbox / select) seeded from its
 * detected default. Ctrl/Cmd+Enter from any input runs the active cell.
 */
/**
 * ノートブック変数の一覧編集パネル。
 * @param variables - 表示する変数の配列。空配列の場合はパネル自体を描画しない。
 * @param onChange - いずれかの変数値が変更されたときに呼ばれるコールバック（変数名と新しい値を渡す）。
 * @param onRunActive - いずれかの入力欄で Ctrl/Cmd+Enter が押されたときに呼ばれ、アクティブセルを実行する。
 */
export function VariablePanel({
  variables,
  onChange,
  onRunActive,
}: {
  variables: Variable[];
  onChange: (name: string, value: string) => void;
  onRunActive: () => void;
}) {
  const t = useT(notebookMessages);
  // 変数が1つも無ければパネルごと非表示にする。
  if (variables.length === 0) return null;

  // Ctrl/Cmd+Enter をどの入力欄からでも捕捉し、アクティブセルの実行をトリガーする共通ハンドラ。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRunActive();
    }
  };

  return (
    <section
      aria-label={t('notebookVariablesAria')}
      data-testid="variable-panel"
      className="mb-4 rounded-lg border border-border-base bg-surface-raised shadow-sm"
    >
      {/* パネルヘッダー：アイコン、タイトル、変数個数の表示 */}
      <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
        <VariableIcon size={14} strokeWidth={1.75} className="text-accent" />
        <h2 className="text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
          {t('variablesHeading')}
        </h2>
        <span className="font-mono text-2xs text-ink-subtle">
          {variables.length === 1
            ? t('parameterCountOne', { n: variables.length })
            : t('parameterCountOther', { n: variables.length })}
        </span>
      </header>
      {/* 変数ごとの入力フィールドをグリッドで並べる（画面幅に応じて列数が変わる） */}
      <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
        {variables.map((v) => (
          <VariableField key={v.name} variable={v} onChange={onChange} onKeyDown={onKeyDown} />
        ))}
      </div>
    </section>
  );
}

// すべての入力コントロールに共通で適用するスタイルクラス。
const INPUT_CLASS =
  'w-full rounded-md border border-border-base bg-surface-base px-2.5 py-1.5 text-sm text-ink-strong ' +
  'placeholder:text-ink-subtle focus:border-accent focus:outline-none';

/**
 * 変数1つ分の入力フィールド。変数のメタ情報（meta.type）に応じて
 * select / checkbox / text系 input のいずれかを描画する。
 * @param variable - 描画対象の変数（名前、現在値、メタ情報を含む）。
 * @param onChange - 値変更時に呼ばれるコールバック（変数名、新しい値）。
 * @param onKeyDown - キー入力時に呼ばれるコールバック（Ctrl/Cmd+Enter の検知に使用）。
 */
function VariableField({
  variable,
  onChange,
  onKeyDown,
}: {
  variable: Variable;
  onChange: (name: string, value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const { name, value, meta } = variable;
  const inputId = `var-${name}`;
  // この変数の値を更新するショートハンド関数。
  const set = (next: string) => onChange(name, next);

  return (
    <label htmlFor={inputId} className="flex flex-col gap-1">
      {/* ラベル：変数名を ${name} 形式（SQL 中の記法と揃えた表示）で表示 */}
      <span className="font-mono text-2xs font-medium tracking-wide text-ink-muted">${name}</span>
      {meta.type === 'select' && meta.options ? (
        // 選択肢が定義されている場合はプルダウン（select）で表示
        <select
          id={inputId}
          value={value}
          onChange={(e) => set(e.target.value)}
          onKeyDown={onKeyDown}
          className={INPUT_CLASS}
        >
          {meta.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : meta.type === 'checkbox' ? (
        // 真偽値変数はチェックボックスで表示。値は文字列 'true'/'false' として保持する。
        <span className="flex h-[34px] items-center">
          <input
            id={inputId}
            type="checkbox"
            checked={value === 'true'}
            onChange={(e) => set(e.target.checked ? 'true' : 'false')}
            onKeyDown={onKeyDown}
            className={cn('h-4 w-4 cursor-pointer accent-accent')}
          />
        </span>
      ) : (
        // それ以外（text / number / date / datetime-local など）は通常の input で表示
        <input
          id={inputId}
          type={meta.type === 'text' ? 'text' : meta.type}
          value={value}
          placeholder={meta.placeholder}
          onChange={(e) => set(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(INPUT_CLASS, meta.type === 'number' && 'tabular-nums')}
        />
      )}
    </label>
  );
}

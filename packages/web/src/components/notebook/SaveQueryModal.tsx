/**
 * SaveQueryModal.tsx
 *
 * SQL セルのツールバー(CellToolbar)から開く、セルの SQL 文を保存済みクエリ
 * (Saved Query) として保存するためのモーダル。名前(必須)と説明(任意)を
 * 入力させ、セルの statement と実行コンテキスト(datasourceId / catalog /
 * schema)を自動で添付して `POST /api/saved-queries` を呼ぶ。保存成功時は
 * SavedQueriesPanel(packages/web/src/components/panels/SavedQueriesPanel.tsx)
 * が使う一覧キャッシュ(query key: ['saved-queries', 'list', ...])を
 * invalidate してから閉じる。SaveNotebookModal / ScheduleFormModal と同じ
 * 「閉じている間は描画しない」流儀を踏襲し、開くたびに入力状態を初期化する。
 */
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateSavedQueryRequest, DatasourceSummary } from '@hubble/contracts';
import {
  createSavedQueryRequestSchema,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
} from '@hubble/contracts';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { createSavedQuery } from '../../api/savedQueries';
import { resolveDatasourceLabel } from '../../hooks/useDatasources';
import { ApiClientError } from '../../api/client';
import { cn } from '../../utils/cn';

// フォーム内のラベル/入力欄で共通利用する Tailwind クラス文字列。
// ScheduleFormModal / SaveNotebookModal と揃えたスタイルにする。
const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

/** このセルが保存対象として持つ実行コンテキスト。値が無いフィールドはリクエストから省略する。 */
export interface SaveQueryContext {
  datasourceId?: string;
  catalog?: string;
  schema?: string;
}

/**
 * 保存モーダルの外殻。`open` が false の間は何も描画しない。これにより次に
 * 開いたときは再マウントされ、入力欄が自然に初期状態へ戻る(SaveNotebookModal
 * と同じ流儀)。
 *
 * @param open モーダルの表示/非表示。
 * @param statement 保存対象の SQL 文(セルの現在のソース)。
 * @param context セルの実行コンテキスト(datasourceId / catalog / schema)。
 * @param datasources 接続先表示用のデータソース一覧。
 * @param onClose 閉じる操作(キャンセル、背景クリック、保存成功時)で呼ばれる。
 */
export function SaveQueryModal({
  open,
  statement,
  context,
  datasources,
  onClose,
}: {
  open: boolean;
  statement: string;
  context: SaveQueryContext;
  datasources: DatasourceSummary[];
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <SaveQueryModalBody
      statement={statement}
      context={context}
      datasources={datasources}
      onClose={onClose}
    />
  );
}

/** 開くたびにマウントし直す、保存フォームの状態保持部分。 */
function SaveQueryModalBody({
  statement,
  context,
  datasources,
  onClose,
}: {
  statement: string;
  context: SaveQueryContext;
  datasources: DatasourceSummary[];
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // 契約上限超過など、送信直前の safeParse で見つかったエラー文言。
  // フィールド単位ではなくフォーム全体のエラーとして表示する。
  const [formError, setFormError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // 二重送信防止用のロック。React state (mutation.isPending) の更新は
  // 非同期なため、同一イベントループ内で保存ボタンを連打すると setState が
  // 反映される前に mutate が複数回呼ばれてしまう。ref への同期的な書き込み
  // で、mutate 呼び出し自体を1回に限定する。
  const isSubmittingRef = useRef(false);

  // 保存済みクエリの作成 mutation。成功時は一覧キャッシュを invalidate して
  // トーストを出し、モーダルを閉じる。失敗時はサーバーのエラー文言を出す。
  const mutation = useMutation({
    mutationFn: (body: CreateSavedQueryRequest) => createSavedQuery(body),
    onSuccess: (saved) => {
      // SavedQueriesPanel が使う ['saved-queries', 'list', <search>] 系の
      // キャッシュをまとめて無効化し、パネルを開いたときに新規保存分を反映させる。
      void queryClient.invalidateQueries({ queryKey: ['saved-queries', 'list'] });
      toast.success('Saved query created', `“${saved.name}” was saved.`);
      onClose();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof ApiClientError ? error.message : 'Could not reach the server.';
      toast.error('Save failed', message);
    },
    onSettled: () => {
      // 成功・失敗いずれで終わっても、次の送信を受け付けられるようロックを解除する。
      isSubmittingRef.current = false;
    },
  });

  const trimmedName = name.trim();
  const nameValid = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LENGTH;
  // 送信中は連打防止のため保存ボタンを無効化する。
  const canSave = nameValid && statement.trim().length > 0 && !mutation.isPending;

  const connectionLabel = context.datasourceId
    ? resolveDatasourceLabel(datasources, context.datasourceId)
    : undefined;

  // 値が無いフィールド(catalog / schema / datasourceId / description)は
  // 契約上すべて optional なので、空ならキー自体を省略して送る。
  const buildRequestBody = (): CreateSavedQueryRequest => ({
    name: name.trim(),
    statement,
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(context.datasourceId ? { datasourceId: context.datasourceId } : {}),
    ...(context.catalog ? { catalog: context.catalog } : {}),
    ...(context.schema ? { schema: context.schema } : {}),
  });

  const submit = () => {
    if (!canSave) return;
    // ロック済み(直前のクリックで既に送信中)なら即座に弾く。mutation.isPending
    // による disabled 反映を待たず、ここで同期的に多重呼び出しを防ぐ。
    if (isSubmittingRef.current) return;

    // name の入力欄は maxLength で頭打ちにしているが、statement(セルの SQL)
    // や context の値(datasourceId / catalog / schema)はユーザー入力でなく
    // 上限を UI 側で強制していないため、送信前に契約全体を safeParse で検証する。
    const body = buildRequestBody();
    const parsed = createSavedQueryRequestSchema.safeParse(body);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Invalid input.');
      return;
    }

    setFormError(null);
    isSubmittingRef.current = true;
    mutation.mutate(parsed.data);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Save query"
      description="Save this cell's SQL as a saved query you can find and reuse later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSave}>
            {mutation.isPending ? 'Saving…' : 'Save query'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 名前(必須)。MAX_NAME_LENGTH を超える入力は input 側で打ち切る。 */}
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Name</span>
          <input
            autoFocus
            value={name}
            aria-label="Saved query name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            maxLength={MAX_NAME_LENGTH}
            placeholder="e.g. Daily active users"
            className={cn(TEXT_INPUT, name.length > 0 && !nameValid && 'border-error')}
          />
          {name.length > 0 && !nameValid && (
            <p role="alert" className="font-mono text-2xs text-error">
              Name is required.
            </p>
          )}
        </label>

        {/* 説明(任意)。 */}
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Description (optional)</span>
          <textarea
            value={description}
            aria-label="Saved query description"
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={MAX_DESCRIPTION_LENGTH}
            placeholder="What this query is for"
            className={cn(TEXT_INPUT, 'resize-y')}
          />
        </label>

        {/* 接続先表示: データソース名と catalog / schema を読み取り専用で提示する。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Connection</span>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-2xs text-ink-muted">
            <span className="rounded-full bg-surface-sunken px-2 py-0.5">
              {connectionLabel ?? 'Server default'}
            </span>
            {context.catalog && (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5">
                {context.catalog}
                {context.schema ? `.${context.schema}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* 保存対象の SQL プレビュー(読み取り専用、数行で truncate)。 */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>SQL preview</span>
          <pre className="max-h-32 overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap text-ink-base">
            {statement}
          </pre>
        </div>

        {/* 送信直前の safeParse で検出した契約違反(上限超過など)。 */}
        {formError && (
          <p role="alert" className="font-mono text-2xs text-error">
            {formError}
          </p>
        )}
      </div>
    </Modal>
  );
}

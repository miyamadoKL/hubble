import { z } from 'zod';
import { apiErrorDetailSchema } from './error';

/**
 * AI アシスタント（SQL assistant MVP）の契約を定義するファイル。
 *
 * server は `POST /api/ai/assist` で LLM provider（Gemini API / GitHub Models）へ
 * ストリーミング推論を中継し、SSE イベント（delta / done / error）として web に配信する。
 * LLM は SQL を実行する経路を一切持たず、提案 SQL の適用と実行は必ず web UI 上の
 * ユーザー操作（diff 確認 + 既存の `POST /api/queries` 経路）に戻す。
 * 公開設定は `GET /api/config` の `ai` フィールドで配信される。
 */

/**
 * AI provider の種別。`off` は AI アシスタント全体の無効化を表す。
 * - `gemini-api`    : Google Gemini API（server 側の API key で呼ぶ）
 * - `github-models` : GitHub Models REST API（server 側の token で呼ぶ）
 */
export const aiProviderKindSchema = z.enum(['off', 'gemini-api', 'github-models']);
/** AI provider 種別の推論型。 */
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>;

/**
 * AI アシスタントのタスク種別（Phase 1 の 4 機能）。
 * - `explain` : 選択 SQL の自然言語説明
 * - `fix`     : エラーメッセージからの修正案
 * - `draft`   : 指示とスキーマ情報からの SQL 下書き
 * - `rewrite` : 指示に基づく SQL の書き換え
 */
export const aiTaskSchema = z.enum(['explain', 'fix', 'draft', 'rewrite']);
/** AI タスク種別の推論型。 */
export type AiTask = z.infer<typeof aiTaskSchema>;

/**
 * prompt に含めるテーブルスキーマ情報（1 テーブル分）。
 * 列情報は既存メタデータ API から取得した名前と型のみを渡し、行データは含めない。
 */
export const aiTableContextSchema = z.object({
  // カタログ名（MySQL / PostgreSQL などカタログ概念がない場合は省略）。
  catalog: z.string().optional(),
  // スキーマ名。
  schema: z.string().min(1),
  // テーブル名。
  table: z.string().min(1),
  // 列の一覧（名前と型のみ）。
  columns: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
      }),
    )
    .max(500),
});
/** テーブルスキーマ情報の推論型。 */
export type AiTableContext = z.infer<typeof aiTableContextSchema>;

/**
 * `POST /api/ai/assist` のリクエストボディ。
 * タスクごとの必須フィールドは superRefine で強制する:
 * - `explain` / `rewrite` / `fix` は `sql` 必須
 * - `fix` は `errorMessage` 必須
 * - `draft` は `instruction` 必須
 */
export const aiAssistRequestSchema = z
  .object({
    // 実行するタスク種別。
    task: aiTaskSchema,
    // 文脈として渡すデータソース id（SQL 方言の判定に使う。省略時は既定データソース）。
    datasourceId: z.string().optional(),
    // 対象 SQL（explain / fix / rewrite で必須）。
    sql: z.string().max(200_000).optional(),
    // エンジンが返したエラーメッセージ（fix で必須）。
    errorMessage: z.string().max(20_000).optional(),
    // ユーザーの自然言語指示（draft で必須、rewrite で任意）。
    instruction: z.string().max(4_000).optional(),
    // prompt に含めるテーブルスキーマ情報（任意）。
    tables: z.array(aiTableContextSchema).max(20).optional(),
    // 現在の catalog.schema コンテキスト（任意。FQN 補完のヒントに使う）。
    context: z
      .object({
        catalog: z.string().optional(),
        schema: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    // タスク別の必須フィールドを契約側で強制する（server の分岐漏れを防ぐ）。
    const requiresSql =
      value.task === 'explain' || value.task === 'fix' || value.task === 'rewrite';
    if (requiresSql && (value.sql === undefined || value.sql.trim() === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['sql'],
        message: `sql is required for task '${value.task}'`,
      });
    }
    if (
      value.task === 'fix' &&
      (value.errorMessage === undefined || value.errorMessage.trim() === '')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorMessage'],
        message: "errorMessage is required for task 'fix'",
      });
    }
    if (
      value.task === 'draft' &&
      (value.instruction === undefined || value.instruction.trim() === '')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['instruction'],
        message: "instruction is required for task 'draft'",
      });
    }
  });
/** `POST /api/ai/assist` リクエストの推論型。 */
export type AiAssistRequest = z.infer<typeof aiAssistRequestSchema>;

// 応答テキストの増分（ストリーミング中に逐次届く）。
export const aiDeltaEventSchema = z.object({
  type: z.literal('delta'),
  // 追記されたテキスト断片。
  text: z.string(),
});

// ストリーム完了イベント。全文と、抽出できた場合は提案 SQL を含む。
export const aiDoneEventSchema = z.object({
  type: z.literal('done'),
  // 応答テキスト全文（delta の連結と一致する）。
  text: z.string(),
  /** 応答から抽出した提案 SQL（fix / draft / rewrite で ```sql ブロックがある場合のみ）。 */
  sql: z.string().optional(),
});

// provider 呼び出し失敗などのエラーイベント。これが届いたらストリームは終了する。
export const aiErrorEventSchema = z.object({
  type: z.literal('error'),
  // エラーの詳細（既存のエラーエンベロープと同じ形状）。
  error: apiErrorDetailSchema,
});

/**
 * `POST /api/ai/assist` が SSE で配信するイベントの discriminated union。
 * SSE の `event:` 名は各スキーマの `type` リテラル値と一致する。
 */
export const aiAssistEventSchema = z.discriminatedUnion('type', [
  aiDeltaEventSchema,
  aiDoneEventSchema,
  aiErrorEventSchema,
]);
/** delta イベントの推論型。 */
export type AiDeltaEvent = z.infer<typeof aiDeltaEventSchema>;
/** done イベントの推論型。 */
export type AiDoneEvent = z.infer<typeof aiDoneEventSchema>;
/** error イベントの推論型。 */
export type AiErrorEvent = z.infer<typeof aiErrorEventSchema>;
/** AI SSE イベント全体の推論型。 */
export type AiAssistEvent = z.infer<typeof aiAssistEventSchema>;

/** AI SSE イベント名の一覧（`type` 判別子と一致）。 */
export const aiAssistEventNames = ['delta', 'done', 'error'] as const;
/** AI SSE イベント名の推論型。 */
export type AiAssistEventName = (typeof aiAssistEventNames)[number];

/**
 * `GET /api/config` で公開する AI アシスタントの公開設定。
 * API key などの機密は含めない。`enabled` は provider が `off` 以外かどうかと一致する。
 */
export const aiPublicConfigSchema = z.object({
  // AI アシスタントが有効か（provider が off 以外）。
  enabled: z.boolean(),
  // 設定されている provider 種別。
  provider: aiProviderKindSchema,
  // 使用モデル名（enabled のときのみ設定される）。
  model: z.string().optional(),
});
/** AI 公開設定の推論型。 */
export type AiPublicConfig = z.infer<typeof aiPublicConfigSchema>;

/** AI アシスタントが無効なときに `POST /api/ai/assist` が返すエラーコード（HTTP 501）。 */
export const AI_DISABLED = 'AI_DISABLED';

/**
 * 結果探索（server-side filter / sort / search / column profile）の契約。
 *
 * `POST /api/queries/:id/rows/search` と `GET /api/queries/:id/profile` の
 * リクエスト/レスポンス schema を定義する。どちらも実行中/TTL 内のメモリ
 * バッファと `RESULT_STORE` の永続化結果の両方を行ソースとして扱う。
 * メモリバッファは QUERY_MAX_ROWS で有界だが、永続化結果は打ち切り前の
 * 全結果を含みうるため、サーバー側はストリーミングかつ有界メモリで評価する。
 */
import { z } from 'zod';

/** 列条件フィルタの比較演算子。 */
export const resultFilterOpSchema = z.enum([
  // 部分一致（大文字小文字を無視）。値は文字列表現に対して比較する。
  'contains',
  // 完全一致（数値型列は数値として、それ以外は文字列として比較）。
  'eq',
  // 不一致。
  'neq',
  // 大小比較（数値型列は数値として、それ以外は文字列として比較）。
  'gt',
  'gte',
  'lt',
  'lte',
  // NULL 判定。value は不要。
  'isNull',
  'notNull',
]);
/** 列条件フィルタ演算子の推論型。 */
export type ResultFilterOp = z.infer<typeof resultFilterOpSchema>;

/** value が不要な演算子の集合。 */
const VALUELESS_OPS: ReadonlySet<ResultFilterOp> = new Set(['isNull', 'notNull']);

/** 1 列に対するフィルタ条件。 */
export const resultFilterConditionSchema = z
  .object({
    /** 対象列のインデックス（0 始まり、結果セットの列順）。 */
    columnIndex: z.number().int().nonnegative(),
    /** 比較演算子。 */
    op: resultFilterOpSchema,
    /** 比較値。isNull / notNull 以外では必須。 */
    value: z.string().optional(),
  })
  .superRefine((condition, ctx) => {
    if (!VALUELESS_OPS.has(condition.op) && condition.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `value is required for op "${condition.op}"`,
      });
    }
  });
/** 列フィルタ条件の推論型。 */
export type ResultFilterCondition = z.infer<typeof resultFilterConditionSchema>;

/** ソート方向。 */
export const resultSortDirSchema = z.enum(['asc', 'desc']);

/** ソート指定。 */
export const resultSortSchema = z.object({
  /** 対象列のインデックス（0 始まり）。 */
  columnIndex: z.number().int().nonnegative(),
  /** 方向。 */
  dir: resultSortDirSchema,
});
/** ソート指定の推論型。 */
export type ResultSort = z.infer<typeof resultSortSchema>;

/** 1 リクエストに指定できる列条件数の上限。 */
export const RESULT_SEARCH_MAX_CONDITIONS = 20;
/** search 結果ページの limit 上限（既存 rows API と同じ）。 */
export const RESULT_SEARCH_MAX_LIMIT = 10_000;

/**
 * `POST /api/queries/:id/rows/search` のリクエストボディ。
 *
 * search（全列の部分一致）と filters（列条件、AND 結合）を併用でき、
 * その結果に sort を適用してから offset / limit でページングする。
 */
export const resultSearchRequestSchema = z.object({
  /** 全列を対象とする部分一致検索（大文字小文字を無視）。 */
  search: z.string().max(1_000).optional(),
  /** 列条件フィルタ（AND 結合）。 */
  filters: z.array(resultFilterConditionSchema).max(RESULT_SEARCH_MAX_CONDITIONS).optional(),
  /** ソート指定。省略時は元の行順。 */
  sort: resultSortSchema.optional(),
  /** ページ先頭のオフセット（フィルタ適用後の行位置、0 始まり）。 */
  offset: z.number().int().nonnegative().default(0),
  /** ページ行数（1〜10,000）。 */
  limit: z.number().int().min(1).max(RESULT_SEARCH_MAX_LIMIT).default(100),
});
/** 検索リクエストの推論型（parse 後）。 */
export type ResultSearchRequest = z.infer<typeof resultSearchRequestSchema>;
/** 検索リクエストの入力型（default 適用前）。 */
export type ResultSearchRequestInput = z.input<typeof resultSearchRequestSchema>;

/** `POST /api/queries/:id/rows/search` のレスポンスボディ。 */
export const resultSearchPageSchema = z.object({
  /** このページの先頭がフィルタ適用後の何行目か（0 始まり）。 */
  offset: z.number().int().nonnegative(),
  /** ページの行データ本体。 */
  rows: z.array(z.array(z.unknown())),
  /** フィルタ適用後の総行数。 */
  totalMatched: z.number().int().nonnegative(),
  /** フィルタ適用前の総行数（サーバーが保持する全行）。 */
  totalRows: z.number().int().nonnegative(),
  /** クエリが終了しており、以降行が増えないことを示す。 */
  complete: z.boolean(),
});
/** 検索結果ページの推論型。 */
export type ResultSearchPage = z.infer<typeof resultSearchPageSchema>;

/** profile の top values に含める値の最大数。 */
export const RESULT_PROFILE_TOP_VALUES = 10;

/** 頻出値とその出現回数。 */
export const resultTopValueSchema = z.object({
  /** 値の文字列表現。NULL は含めない（nullCount で別掲）。 */
  value: z.string(),
  /** 出現回数。 */
  count: z.number().int().positive(),
});

/** 1 列分のプロファイル。 */
export const resultColumnProfileSchema = z.object({
  /** 列名。 */
  name: z.string(),
  /** 列型。 */
  type: z.string(),
  /** NULL の行数。 */
  nullCount: z.number().int().nonnegative(),
  /**
   * distinct 値数。distinctOverflow が true のときは追跡上限までの下限値
   * （実際の distinct 数はこれ以上）。
   */
  distinctCount: z.number().int().nonnegative(),
  /** distinct 追跡が上限に達し、distinctCount が下限値であることを示す。 */
  distinctOverflow: z.boolean(),
  /** 最小値の文字列表現（数値型列は数値順、それ以外は辞書順。全行 NULL なら未設定）。 */
  min: z.string().optional(),
  /** 最大値の文字列表現。 */
  max: z.string().optional(),
  /** 頻出値の上位（distinctOverflow 時は追跡できた範囲での概算）。 */
  topValues: z.array(resultTopValueSchema).max(RESULT_PROFILE_TOP_VALUES),
});
/** 列プロファイルの推論型。 */
export type ResultColumnProfile = z.infer<typeof resultColumnProfileSchema>;

/** `GET /api/queries/:id/profile` のレスポンスボディ。 */
export const resultProfileSchema = z.object({
  /** プロファイル対象となった行数。 */
  rowCount: z.number().int().nonnegative(),
  /** クエリが終了しており、以降行が増えないことを示す。 */
  complete: z.boolean(),
  /** 列ごとのプロファイル。 */
  columns: z.array(resultColumnProfileSchema),
});
/** 結果プロファイルの推論型。 */
export type ResultProfile = z.infer<typeof resultProfileSchema>;

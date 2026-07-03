/**
 * datasources.yaml の zod スキーマ定義。
 *
 * YAML から読み込んだ生データをバリデーションし、種別ごとの必須フィールドや
 * id 形式、passwordEnv/passwordFile の排他制約を検証する。
 */
import { z } from 'zod';

/** データソース id の許容パターン（小文字英字始まり、最大 63 文字）。 */
export const datasourceIdPattern = /^[a-z][a-z0-9-]{0,62}$/;

const datasourceIdSchema = z
  .string()
  .regex(datasourceIdPattern, 'must match /^[a-z][a-z0-9-]{0,62}$/');

/** 全種別で共通の YAML フィールド。 */
const baseDatasourceSchema = z
  .object({
    id: datasourceIdSchema,
    displayName: z.string().min(1).optional(),
    username: z.string().min(1),
    passwordEnv: z.string().min(1).optional(),
    passwordFile: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.passwordEnv !== undefined && value.passwordFile !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'passwordEnv and passwordFile cannot both be set',
        path: ['passwordEnv'],
      });
    }
  });

/** Trino データソースの YAML エントリ。 */
export const trinoDatasourceSchema = baseDatasourceSchema.safeExtend({
  type: z.literal('trino'),
  baseUrl: z.url(),
  source: z.string().min(1).optional(),
});

/** MySQL データソースの YAML エントリ。 */
export const mysqlDatasourceSchema = baseDatasourceSchema.safeExtend({
  type: z.literal('mysql'),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  database: z.string().min(1),
});

/** PostgreSQL データソースの YAML エントリ。 */
export const postgresqlDatasourceSchema = baseDatasourceSchema.safeExtend({
  type: z.literal('postgresql'),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  database: z.string().min(1),
});

/** 種別で分岐するデータソース 1 件分のスキーマ。 */
export const datasourceEntrySchema = z.discriminatedUnion('type', [
  trinoDatasourceSchema,
  mysqlDatasourceSchema,
  postgresqlDatasourceSchema,
]);

/** datasources.yaml のルート構造。 */
export const datasourcesFileSchema = z.object({
  datasources: z.array(datasourceEntrySchema).min(1),
});

export type DatasourceEntry = z.infer<typeof datasourceEntrySchema>;
export type DatasourcesFile = z.infer<typeof datasourcesFileSchema>;

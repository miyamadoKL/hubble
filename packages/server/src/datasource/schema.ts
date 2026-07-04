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

const roleNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, 'must match /^[a-z][a-z0-9-]{0,62}$/');

/** RBAC role ごとに DB 接続ユーザーを切り替えるための credential。 */
const roleCredentialSchema = z
  .object({
    username: z.string().min(1),
    password: z.never().optional(),
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
    if (value.passwordEnv === undefined && value.passwordFile === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'passwordEnv or passwordFile is required',
        path: ['passwordEnv'],
      });
    }
  });

/** 全種別で共通の YAML フィールド。 */
const baseDatasourceSchema = z
  .object({
    id: datasourceIdSchema,
    displayName: z.string().min(1).optional(),
    username: z.string().min(1),
    password: z.never().optional(),
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

/**
 * Trino データソースの YAML エントリ。
 *
 * `source` / `metadataSource` / `scheduledSource` はいずれも任意で、
 * `X-Trino-Source` ヘッダに用途別に付与する値(既定値はそれぞれ
 * `hubble` / `hubble-metadata` / `hubble-scheduled`)。resource group を
 * ソース種別ごとに分けたい場合に上書きする。
 */
export const trinoDatasourceSchema = baseDatasourceSchema.safeExtend({
  type: z.literal('trino'),
  baseUrl: z.url(),
  source: z.string().min(1).optional(),
  metadataSource: z.string().min(1).optional(),
  scheduledSource: z.string().min(1).optional(),
});

/** tlsCaFile は tls: true が必須であることを検証する。 */
function refineTlsCaFile(value: { tls?: boolean; tlsCaFile?: string }, ctx: z.RefinementCtx): void {
  if (value.tlsCaFile !== undefined && value.tls !== true) {
    ctx.addIssue({
      code: 'custom',
      message: 'tlsCaFile requires tls: true',
      path: ['tlsCaFile'],
    });
  }
}

/** MySQL データソースの YAML エントリ。 */
export const mysqlDatasourceSchema = baseDatasourceSchema
  .safeExtend({
    type: z.literal('mysql'),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    database: z.string().min(1),
    readOnly: z.boolean().optional(),
    tls: z.boolean().optional(),
    tlsCaFile: z.string().min(1).optional(),
    maxConnections: z.number().int().positive().optional(),
    roleCredentials: z.record(roleNameSchema, roleCredentialSchema).optional(),
  })
  .superRefine(refineTlsCaFile);

/** PostgreSQL データソースの YAML エントリ。 */
export const postgresqlDatasourceSchema = baseDatasourceSchema
  .safeExtend({
    type: z.literal('postgresql'),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    database: z.string().min(1),
    readOnly: z.boolean().optional(),
    tls: z.boolean().optional(),
    tlsCaFile: z.string().min(1).optional(),
    maxConnections: z.number().int().positive().optional(),
    roleCredentials: z.record(roleNameSchema, roleCredentialSchema).optional(),
  })
  .superRefine(refineTlsCaFile);

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

/**
 * GitHub 正規形コンテンツの逆変換パーサ。
 *
 * canonical.ts が生成する .sql / YAML をドキュメント更新用フィールドへ戻す純粋関数群。
 */
import { parse as parseYaml } from 'yaml';
import {
  alertNotificationsSchema,
  alertNotificationChannelSchema,
  alertOpSchema,
  alertSelectorSchema,
  chartConfigSchema,
  counterConfigSchema,
  cronExpression,
  dashboardWidgetSchema,
  notebookContextSchema,
  retryPolicySchema,
  variableSchema,
  widgetPositionSchema,
  widgetVizSchema,
  workflowDefinitionSchema,
  cellKindSchema,
} from '@hubble/contracts';
import { z } from 'zod';
import { newId } from '../util/id';

const HEADER_PREFIX = '-- ';

/** 保存済みクエリ正規形のパース結果。 */
export interface ParsedSavedQueryContent {
  name: string;
  description: string;
  datasourceId?: string;
  catalog?: string;
  schema?: string;
  statement: string;
}

/** ノートブック正規形のパース結果。 */
export interface ParsedNotebookContent {
  name: string;
  description: string;
  context: z.infer<typeof notebookContextSchema>;
  variables: z.infer<typeof variableSchema>[];
  cells: Array<{
    id: string;
    kind: z.infer<typeof cellKindSchema>;
    source: string;
    name?: string;
    collapsed?: boolean;
    chart?: z.infer<typeof chartConfigSchema>;
  }>;
}

/** ワークフロー正規形のパース結果。 */
export interface ParsedWorkflowContent {
  name: string;
  description: string;
  datasourceId: string;
  cron: string | null;
  retry: z.infer<typeof retryPolicySchema>;
  stages: z.infer<typeof workflowDefinitionSchema>;
}

/** Alert 正規形のパース結果。 */
export interface ParsedAlertContent {
  name: string;
  savedQueryId: string;
  columnName: string;
  op: z.infer<typeof alertOpSchema>;
  value: string;
  selector: z.infer<typeof alertSelectorSchema>;
  rearm: number;
  muted: boolean;
  cron: string;
  notifications: z.infer<typeof alertNotificationsSchema>;
}

/** Dashboard 正規形のパース結果。 */
export interface ParsedDashboardContent {
  name: string;
  description: string;
  widgets: z.infer<typeof dashboardWidgetSchema>[];
}

const notebookCellContentSchema = z.object({
  kind: cellKindSchema,
  source: z.string(),
  name: z.string().optional(),
  collapsed: z.boolean().optional(),
  chart: chartConfigSchema.optional(),
});

const notebookContentSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  context: notebookContextSchema,
  variables: z.array(variableSchema),
  cells: z.array(notebookCellContentSchema).min(1),
});

const workflowContentSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  datasourceId: z.string().min(1),
  cron: cronExpression.nullable(),
  retry: retryPolicySchema,
  stages: workflowDefinitionSchema,
});

// Git正規形は秘密値を保持しないため、webhookチャネルでもURLの省略を許可する。
const gitAlertNotificationsSchema = z
  .object({
    channels: z
      .array(alertNotificationChannelSchema)
      .default([])
      .refine((channels) => new Set(channels).size === channels.length, {
        message: 'Duplicate notification channels are not allowed',
      }),
    emailTo: z.array(z.string().email()).max(10).optional(),
    webhookUrl: z.string().url().optional(),
  })
  .superRefine((notifications, ctx) => {
    if (notifications.channels.includes('email') && (notifications.emailTo?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emailTo'],
        message: 'emailTo is required when email notifications are enabled',
      });
    }
  });

const alertContentSchema = z.object({
  name: z.string().min(1),
  savedQueryId: z.string().min(1),
  columnName: z.string().min(1),
  op: alertOpSchema,
  value: z.string(),
  selector: alertSelectorSchema,
  rearm: z.number().int().nonnegative(),
  muted: z.boolean(),
  cron: cronExpression,
  notifications: gitAlertNotificationsSchema,
});

const dashboardQueryWidgetContentSchema = z.object({
  kind: z.literal('query'),
  position: widgetPositionSchema,
  savedQueryId: z.string().min(1),
  viz: widgetVizSchema,
  chart: chartConfigSchema.optional(),
  counter: counterConfigSchema.optional(),
  title: z.string().optional(),
});

const dashboardTextWidgetContentSchema = z.object({
  kind: z.literal('text'),
  position: widgetPositionSchema,
  text: z.string(),
});

const dashboardWidgetContentSchema = z.discriminatedUnion('kind', [
  dashboardQueryWidgetContentSchema,
  dashboardTextWidgetContentSchema,
]);

const dashboardContentSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  widgets: z.array(dashboardWidgetContentSchema),
});

function parseError(message: string): Error {
  return new Error(message);
}

/**
 * 保存済みクエリの .sql 正規形をパースする。
 * @param content - GitHub 上の .sql 本文。
 */
export function parseSavedQueryContent(content: string): ParsedSavedQueryContent {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let name: string | undefined;
  let description = '';
  let datasourceId: string | undefined;
  let catalog: string | undefined;
  let schema: string | undefined;
  let i = 0;

  headerScan: for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith(HEADER_PREFIX)) {
      break headerScan;
    }
    const header = line.slice(HEADER_PREFIX.length);
    const colon = header.indexOf(':');
    if (colon === -1) {
      break headerScan;
    }
    const key = header.slice(0, colon).trim();
    const value = header.slice(colon + 1).trim();
    switch (key) {
      case 'name':
        name = value;
        break;
      case 'description':
        description = value;
        break;
      case 'datasource':
        datasourceId = value || undefined;
        break;
      case 'catalog':
        catalog = value || undefined;
        break;
      case 'schema':
        schema = value || undefined;
        break;
      default:
        break headerScan;
    }
  }

  for (; i < lines.length && lines[i]!.trim() === ''; i += 1) {
    // 空行をスキップする。
  }

  if (!name) {
    throw parseError('Missing required header: -- name:');
  }

  const statement = lines.slice(i).join('\n').replace(/\s+$/, '');
  if (statement.trim() === '') {
    throw parseError('SQL statement is empty');
  }

  return {
    name,
    description,
    datasourceId,
    catalog,
    schema,
    statement,
  };
}

/**
 * ノートブックの YAML 正規形をパースする。
 * @param content - GitHub 上の .yaml 本文。
 */
export function parseNotebookContent(content: string): ParsedNotebookContent {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw parseError(`Invalid notebook YAML: ${message}`);
  }

  const result = notebookContentSchema.safeParse(parsed);
  if (!result.success) {
    throw parseError(`Invalid notebook content: ${result.error.message}`);
  }

  return {
    name: result.data.name,
    description: result.data.description,
    context: result.data.context,
    variables: result.data.variables,
    cells: result.data.cells.map((cell) => ({
      id: newId('c_'),
      kind: cell.kind,
      source: cell.source,
      ...(cell.name !== undefined ? { name: cell.name } : {}),
      ...(cell.collapsed !== undefined ? { collapsed: cell.collapsed } : {}),
      ...(cell.chart !== undefined ? { chart: cell.chart } : {}),
    })),
  };
}

/**
 * ワークフローの YAML 正規形をパースする。
 * @param content - GitHub 上の .yaml 本文。
 */
export function parseWorkflowContent(content: string): ParsedWorkflowContent {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw parseError(`Invalid workflow YAML: ${message}`);
  }

  const result = workflowContentSchema.safeParse(parsed);
  if (!result.success) {
    throw parseError(`Invalid workflow content: ${result.error.message}`);
  }

  return {
    name: result.data.name,
    description: result.data.description,
    datasourceId: result.data.datasourceId,
    cron: result.data.cron,
    retry: result.data.retry,
    stages: result.data.stages,
  };
}

/**
 * Alert の YAML 正規形をパースする。
 * @param content - GitHub 上の .yaml 本文。
 */
export function parseAlertContent(content: string): ParsedAlertContent {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw parseError(`Invalid alert YAML: ${message}`);
  }

  const result = alertContentSchema.safeParse(parsed);
  if (!result.success) {
    throw parseError(`Invalid alert content: ${result.error.message}`);
  }

  return result.data;
}

/**
 * Dashboard の YAML 正規形をパースする。widget id は pull 時に新規採番する。
 * savedQueryId の参照先存在は検証しない。
 * @param content - GitHub 上の .yaml 本文。
 */
export function parseDashboardContent(content: string): ParsedDashboardContent {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw parseError(`Invalid dashboard YAML: ${message}`);
  }

  const result = dashboardContentSchema.safeParse(parsed);
  if (!result.success) {
    throw parseError(`Invalid dashboard content: ${result.error.message}`);
  }

  return {
    name: result.data.name,
    description: result.data.description,
    widgets: result.data.widgets.map((widget) =>
      dashboardWidgetSchema.parse({
        id: newId('wgt_'),
        ...widget,
      }),
    ),
  };
}

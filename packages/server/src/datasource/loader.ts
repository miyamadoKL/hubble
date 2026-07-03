/**
 * datasources.yaml の読み込みと解決済みデータソースへの変換。
 *
 * `DATASOURCES_PATH` または `./datasources.yaml` から宣言的設定を読み込み、
 * 未設定時は既存の `TRINO_*` 環境変数から単一データソースを合成する。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';
import type { ServerConfig } from '../config';
import { datasourcesFileSchema, type DatasourceEntry } from './schema';
import type { ResolvedDatasource } from './types';

type Env = Record<string, string | undefined>;

/** `loadDatasources` に渡すオプション。 */
export interface LoadDatasourcesOptions {
  /** 環境変数（既定は `process.env`）。 */
  env?: Env;
  /** 後方互換フォールバック用の Trino 設定。 */
  trino: ServerConfig['trino'];
  /** 作業ディレクトリ（既定は `process.cwd()`）。 */
  cwd?: string;
}

/**
 * zod の issue パスを人が読めるフィールドパス文字列に整形する。
 * @param path - zod issue の path 配列。
 * @returns 例: `datasources[0].id`
 */
function formatIssuePath(path: PropertyKey[]): string {
  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else {
      formatted += formatted === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return formatted;
}

/**
 * zod バリデーションエラーを起動時エラーメッセージに変換する。
 * @param error - zod のパースエラー。
 * @returns 整形済みメッセージ。
 */
function formatZodIssues(issues: ZodError['issues']): string {
  return issues
    .map((issue) => {
      const field = formatIssuePath(issue.path);
      const prefix = field.startsWith('datasources') ? field : `datasources.${field}`;
      return `${prefix}: ${issue.message}`;
    })
    .join('; ');
}

function formatZodError(error: ZodError): string {
  return formatZodIssues(error.issues);
}

/**
 * YAML エントリからパスワードを解決する。
 * @param entry - バリデーション済み YAML エントリ。
 * @param env - 環境変数。
 * @returns 解決済みパスワード文字列。
 */
function resolvePassword(entry: DatasourceEntry, env: Env): string {
  if (entry.passwordEnv !== undefined) {
    const value = env[entry.passwordEnv];
    if (value === undefined) {
      throw new Error(
        `datasource '${entry.id}': passwordEnv '${entry.passwordEnv}' is not set`,
      );
    }
    return value;
  }

  if (entry.passwordFile !== undefined) {
    try {
      const raw = readFileSync(entry.passwordFile, 'utf8');
      return raw.replace(/\r?\n$/, '');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `datasource '${entry.id}': passwordFile '${entry.passwordFile}' cannot be read: ${detail}`,
        { cause: err },
      );
    }
  }

  return '';
}

/**
 * バリデーション済み YAML エントリを解決済みデータソースに変換する。
 * @param entry - YAML エントリ。
 * @param env - 環境変数。
 * @returns 解決済みデータソース。
 */
function resolveEntry(entry: DatasourceEntry, env: Env): ResolvedDatasource {
  const displayName = entry.displayName ?? entry.id;
  const password = resolvePassword(entry, env);

  switch (entry.type) {
    case 'trino':
      return {
        id: entry.id,
        type: 'trino',
        displayName,
        username: entry.username,
        password,
        baseUrl: entry.baseUrl,
        source: entry.source ?? 'hubble',
      };
    case 'mysql':
      return {
        id: entry.id,
        type: 'mysql',
        displayName,
        username: entry.username,
        password,
        host: entry.host,
        port: entry.port ?? 3306,
        database: entry.database,
      };
    case 'postgresql':
      return {
        id: entry.id,
        type: 'postgresql',
        displayName,
        username: entry.username,
        password,
        host: entry.host,
        port: entry.port ?? 5432,
        database: entry.database,
      };
    default: {
      const _exhaustive: never = entry;
      throw new Error(`unsupported datasource type: ${(_exhaustive as DatasourceEntry).type}`);
    }
  }
}

/**
 * 重複 id が無いことを検証する。
 * @param entries - バリデーション済みエントリ一覧。
 */
function assertUniqueIds(entries: DatasourceEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`datasource '${entry.id}': duplicate id`);
    }
    seen.add(entry.id);
  }
}

/**
 * YAML ファイルを読み込み、解決済みデータソース一覧を返す。
 * @param filePath - 読み込む YAML ファイルの絶対パス。
 * @param env - 環境変数。
 * @returns 解決済みデータソース一覧（YAML の記述順）。
 */
function loadFromFile(filePath: string, env: Env): ResolvedDatasource[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`datasources file '${filePath}' cannot be read: ${detail}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`datasources file '${filePath}' is not valid YAML: ${detail}`, { cause: err });
  }

  const fileResult = datasourcesFileSchema.safeParse(parsed);
  if (!fileResult.success) {
    throw new Error(`datasources file '${filePath}': ${formatZodError(fileResult.error)}`);
  }

  const entries = fileResult.data.datasources;
  assertUniqueIds(entries);
  return entries.map((entry) => resolveEntry(entry, env));
}

/**
 * 既存 TRINO_* 設定から単一の Trino データソースを合成する（後方互換）。
 * @param trino - `loadServerConfig()` の trino セクション。
 * @returns 合成された解決済みデータソース 1 件。
 */
function fallbackFromTrinoConfig(trino: ServerConfig['trino']): ResolvedDatasource[] {
  return [
    {
      id: 'trino-default',
      type: 'trino',
      displayName: 'Trino',
      username: trino.username,
      password: trino.password,
      baseUrl: trino.baseUrl,
      source: trino.source,
    },
  ];
}

/**
 * 宣言的データソース設定を読み込み、解決済み一覧を返す。
 *
 * - `DATASOURCES_PATH` が設定されていればそのファイルを必須として読む
 * - 未設定なら `./datasources.yaml` があれば読む
 * - どちらも無ければ `TRINO_*` から `trino-default` を合成する
 *
 * @param options - 環境変数と Trino 設定。
 * @returns 解決済みデータソース一覧。
 */
export function loadDatasources(options: LoadDatasourcesOptions): ResolvedDatasource[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicitPath = env.DATASOURCES_PATH;

  if (explicitPath !== undefined && explicitPath !== '') {
    return loadFromFile(resolve(cwd, explicitPath), env);
  }

  const defaultPath = resolve(cwd, 'datasources.yaml');
  if (existsSync(defaultPath)) {
    return loadFromFile(defaultPath, env);
  }

  return fallbackFromTrinoConfig(options.trino);
}

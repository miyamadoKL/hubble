/**
 * datasources.yaml の読み込みと解決済みデータソースへの変換。
 *
 * `DATASOURCES_PATH`（未設定時は `./datasources.yaml`）から宣言的設定を読み込む。
 * このファイルは必須であり、存在しない場合は起動時に例外を投げる(Postgres
 * ファースト移行により、`TRINO_*` 環境変数から `trino-default` データソースを
 * 自動合成していた後方互換フォールバックは廃止された)。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';
import { datasourcesFileSchema, type DatasourceEntry } from './schema';
import { resolveSqlConnectionOptions } from './connectionOptions';
import type { ResolvedDatasource, ResolvedSqlRoleCredential } from './types';

type Env = Record<string, string | undefined>;
type PasswordRef = {
  id: string;
  passwordEnv?: string;
  passwordFile?: string;
};

/** `loadDatasources` に渡すオプション。 */
export interface LoadDatasourcesOptions {
  /** 環境変数（既定は `process.env`）。 */
  env?: Env;
  /** 作業ディレクトリ（既定は `process.cwd()`）。 */
  cwd?: string;
  /** 解決時に参照した secret file の絶対パスを格納する集合。 */
  dependencyFiles?: Set<string>;
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
function resolvePassword(
  entry: PasswordRef,
  env: Env,
  dependencyFiles: Set<string>,
  baseDir: string,
): string {
  if (entry.passwordEnv !== undefined) {
    const value = env[entry.passwordEnv];
    if (value === undefined) {
      throw new Error(`datasource '${entry.id}': passwordEnv '${entry.passwordEnv}' is not set`);
    }
    return value;
  }

  if (entry.passwordFile !== undefined) {
    const passwordPath = resolve(baseDir, entry.passwordFile);
    dependencyFiles.add(passwordPath);
    try {
      const raw = readFileSync(passwordPath, 'utf8');
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
 * roleCredentials の各パスワード参照を解決済み credential へ変換する。
 * @param entry - YAML エントリ。
 * @param env - 環境変数。
 * @returns role 名をキーにした解決済み credential 写像。
 */
function resolveRoleCredentials(
  entry: Extract<DatasourceEntry, { type: 'mysql' | 'postgresql' }>,
  env: Env,
  dependencyFiles: Set<string>,
  baseDir: string,
): Record<string, ResolvedSqlRoleCredential> | undefined {
  if (entry.roleCredentials === undefined) return undefined;
  const resolved: Record<string, ResolvedSqlRoleCredential> = {};
  for (const [roleName, credential] of Object.entries(entry.roleCredentials)) {
    resolved[roleName] = {
      username: credential.username,
      password: resolvePassword(
        {
          id: `${entry.id}.roleCredentials.${roleName}`,
          passwordEnv: credential.passwordEnv,
          passwordFile: credential.passwordFile,
        },
        env,
        dependencyFiles,
        baseDir,
      ),
    };
  }
  return resolved;
}

/**
 * バリデーション済み YAML エントリを解決済みデータソースに変換する。
 * @param entry - YAML エントリ。
 * @param env - 環境変数。
 * @returns 解決済みデータソース。
 */
function resolveEntry(
  entry: DatasourceEntry,
  env: Env,
  dependencyFiles: Set<string>,
  baseDir: string,
): ResolvedDatasource {
  const displayName = entry.displayName ?? entry.id;
  const password = resolvePassword(entry, env, dependencyFiles, baseDir);
  const tlsCaFile =
    'tlsCaFile' in entry && entry.tlsCaFile !== undefined
      ? resolve(baseDir, entry.tlsCaFile)
      : undefined;
  if ('tlsCaFile' in entry && entry.tlsCaFile !== undefined) {
    dependencyFiles.add(tlsCaFile!);
  }

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
        metadataSource: entry.metadataSource ?? 'hubble-metadata',
        scheduledSource: entry.scheduledSource ?? 'hubble-scheduled',
      };
    case 'mysql': {
      const conn = resolveSqlConnectionOptions(entry.id, { ...entry, tlsCaFile });
      const roleCredentials = resolveRoleCredentials(entry, env, dependencyFiles, baseDir);
      return {
        id: entry.id,
        type: 'mysql',
        displayName,
        username: entry.username,
        password,
        host: entry.host,
        port: entry.port ?? 3306,
        database: entry.database,
        ...conn,
        ...(roleCredentials !== undefined ? { roleCredentials } : {}),
      };
    }
    case 'postgresql': {
      const conn = resolveSqlConnectionOptions(entry.id, { ...entry, tlsCaFile });
      const roleCredentials = resolveRoleCredentials(entry, env, dependencyFiles, baseDir);
      return {
        id: entry.id,
        type: 'postgresql',
        displayName,
        username: entry.username,
        password,
        host: entry.host,
        port: entry.port ?? 5432,
        database: entry.database,
        ...conn,
        ...(roleCredentials !== undefined ? { roleCredentials } : {}),
      };
    }
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
function loadFromFile(
  filePath: string,
  env: Env,
  dependencyFiles: Set<string>,
): ResolvedDatasource[] {
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
  const baseDir = dirname(filePath);
  return entries.map((entry) => resolveEntry(entry, env, dependencyFiles, baseDir));
}

/**
 * `datasources.yaml` の実ファイルパスを解決する。
 *
 * - `DATASOURCES_PATH` が設定されていればそのパスを使う(相対パスは `cwd` 起点)
 * - 未設定なら `./datasources.yaml` を既定パスとして使う
 *
 * ファイルの存在確認はここでは行わない。存在しない場合の必須化エラーは
 * `loadDatasources` 側の責務とする。
 *
 * @param env - 環境変数。
 * @param cwd - 作業ディレクトリ。
 * @returns 解決済みファイルパス。
 */
export function resolveDatasourcesPath(env: Env, cwd: string): string {
  const explicitPath = env.DATASOURCES_PATH;
  if (explicitPath !== undefined && explicitPath !== '') {
    return resolve(cwd, explicitPath);
  }
  return resolve(cwd, 'datasources.yaml');
}

/**
 * 宣言的データソース設定(`datasources.yaml`)を読み込み、解決済み一覧を返す。
 *
 * このファイルは必須である。`DATASOURCES_PATH` で指定したパス、または既定の
 * `./datasources.yaml` のどちらにもファイルが存在しない場合は、起動時エラーとして
 * 即座に例外を投げる(`TRINO_*` 環境変数から単一データソースを自動合成する
 * 後方互換フォールバックは廃止済み)。
 *
 * @param options - 環境変数と作業ディレクトリ。
 * @returns 解決済みデータソース一覧。
 */
export function loadDatasources(options: LoadDatasourcesOptions): ResolvedDatasource[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const filePath = resolveDatasourcesPath(env, cwd);
  if (!existsSync(filePath)) {
    throw new Error(
      'datasources.yaml が見つからない。DATASOURCES_PATH で指定するか ./datasources.yaml を作成せよ' +
        ` (探索したパス: '${filePath}')`,
    );
  }
  const dependencyFiles = options.dependencyFiles ?? new Set<string>();
  dependencyFiles.clear();
  return loadFromFile(filePath, env, dependencyFiles);
}

/**
 * rbac.yaml の読み込みと解決済み RBAC 設定への変換。
 *
 * `RBAC_PATH` または `./rbac.yaml` から宣言的設定を読み込む。
 * RBAC ファイルが存在しない場合は起動を失敗させる。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';
import type { Permission } from '@hubble/contracts';
import { rbacFileSchema, type RbacFile } from './schema';
import type { LoadedRbac, RoleDatasourcesAllowlist, RoleGuardOverrides } from './types';

type Env = Record<string, string | undefined>;

/** `loadRbac` に渡すオプション。 */
export interface LoadRbacOptions {
  /** 環境変数（既定は `process.env`）。 */
  env?: Env;
  /** 作業ディレクトリ（既定は `process.cwd()`）。 */
  cwd?: string;
}

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

function formatZodIssues(issues: ZodError['issues']): string {
  return issues
    .map((issue) => {
      const field = formatIssuePath(issue.path);
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

function toLoadedRbac(file: RbacFile): LoadedRbac {
  const roles = new Map<
    string,
    {
      permissions: ReadonlySet<Permission>;
      guard?: RoleGuardOverrides;
      datasources: RoleDatasourcesAllowlist;
    }
  >();
  for (const [name, definition] of Object.entries(file.roles)) {
    roles.set(name, {
      permissions: new Set(definition.permissions),
      ...(definition.guard !== undefined ? { guard: definition.guard } : {}),
      datasources: definition.datasources,
    });
  }
  return {
    roles,
    assignments: file.assignments
      .map((assignment, index) => ({ assignment, index }))
      .sort(
        (left, right) =>
          (right.assignment.priority ?? 0) - (left.assignment.priority ?? 0) ||
          left.index - right.index,
      )
      .map(({ assignment }) => assignment),
    defaultRole: file.defaultRole,
  };
}

function loadFromFile(path: string): LoadedRbac {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`rbac file '${path}' cannot be read: ${detail}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`rbac file '${path}' is not valid YAML: ${detail}`, { cause: err });
  }

  const result = rbacFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`rbac file '${path}': ${formatZodIssues(result.error.issues)}`);
  }

  return toLoadedRbac(result.data);
}

/**
 * ホットリロード監視用の rbac ファイルパスを返す。
 *
 * 設定された RBAC ファイルのパスを返す。
 */
export function resolveRbacPath(env: Env, cwd: string): string {
  const explicitPath = env.RBAC_PATH;
  if (explicitPath !== undefined && explicitPath !== '') {
    return resolve(cwd, explicitPath);
  }
  return resolve(cwd, 'rbac.yaml');
}

/**
 * 宣言的 RBAC 設定を読み込み、解決済み設定を返す。
 *
 * - `RBAC_PATH` が設定されていればそのファイルを読む
 * - 未設定なら `./rbac.yaml` を読む
 * - RBAC file が無ければ起動を失敗させる
 */
export function loadRbac(options: LoadRbacOptions = {}): LoadedRbac {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicitPath = env.RBAC_PATH;

  if (explicitPath !== undefined && explicitPath !== '') {
    return loadFromFile(resolve(cwd, explicitPath));
  }

  const defaultPath = resolve(cwd, 'rbac.yaml');
  return loadFromFile(defaultPath);
}

/**
 * MySQL/PostgreSQL 共通の接続オプション解決。
 */
import { readFileSync } from 'node:fs';

/** mysql/postgresql YAML エントリから読み取る接続オプション。 */
export interface SqlConnectionOptionsInput {
  readOnly?: boolean;
  tls?: boolean;
  tlsCaFile?: string;
  maxConnections?: number;
}

/** 解決済みの SQL 接続オプション。 */
export interface ResolvedSqlConnectionOptions {
  /** 省略時 true。セッション初期化で READ ONLY を発行するガードレール。 */
  readOnly: boolean;
  tls: boolean;
  /** tls: true かつ tlsCaFile 指定時に読み込んだ CA 証明書。 */
  tlsCa?: string;
  maxConnections: number;
}

/**
 * tlsCaFile を読み込む。読めなければ起動エラー（passwordFile と同じ扱い）。
 * @param datasourceId - エラーメッセージ用のデータソース id。
 * @param path - CA ファイルパス。
 * @returns PEM 文字列。
 */
export function readTlsCaFile(datasourceId: string, path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `datasource '${datasourceId}': tlsCaFile '${path}' cannot be read: ${detail}`,
      { cause: err },
    );
  }
}

/**
 * YAML の接続オプションを解決済み形へ変換する。
 * @param datasourceId - データソース id。
 * @param input - YAML エントリの接続オプション。
 * @returns 解決済みオプション。
 */
export function resolveSqlConnectionOptions(
  datasourceId: string,
  input: SqlConnectionOptionsInput,
): ResolvedSqlConnectionOptions {
  const readOnly = input.readOnly ?? true;
  const tls = input.tls ?? false;
  const maxConnections = input.maxConnections ?? 5;
  let tlsCa: string | undefined;
  if (input.tlsCaFile !== undefined) {
    tlsCa = readTlsCaFile(datasourceId, input.tlsCaFile);
  }
  return { readOnly, tls, tlsCa, maxConnections };
}
/**
 * DuckDB の S3 temporary secret に渡す endpoint と credential chain の契約。
 *
 * secret の値は SQL に埋め込まず、node-api の parameter binding で渡す。
 * endpoint は custom S3 互換ストレージと AWS default の URL style を分ける。
 */
import type { DuckDBConnection } from '@duckdb/node-api';

export interface DuckdbS3Endpoint {
  /** DuckDB の ENDPOINT に渡す host:port。AWS default では未設定。 */
  host?: string;
  /** DuckDB の USE_SSL に渡す値。 */
  useSsl: boolean;
  /** endpoint が明示された場合は path、AWS default は vhost。 */
  urlStyle: 'path' | 'vhost';
}

export interface DuckdbS3TemporarySecretInput {
  name: string;
  scope: string;
  region: string;
  endpoint?: string;
  sessionToken?: string;
}

export interface DuckdbS3SecretStatement {
  sql: string;
  parameters: Array<string | boolean>;
}

function validateIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid DuckDB secret name: ${name}`);
  }
  return name;
}

/** custom endpoint を URL として検証し、DuckDB の S3 設定へ分解する。 */
export function parseDuckdbS3Endpoint(rawEndpoint?: string): DuckdbS3Endpoint {
  if (rawEndpoint === undefined || rawEndpoint.trim() === '') {
    return { useSsl: true, urlStyle: 'vhost' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch (error) {
    throw new Error('DuckDB S3 endpoint must be an absolute URL', { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('DuckDB S3 endpoint must use http or https');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === ''
  ) {
    throw new Error('DuckDB S3 endpoint must not contain userinfo, path, query, or fragment');
  }
  return {
    host: parsed.host,
    useSsl: parsed.protocol === 'https:',
    urlStyle: 'path',
  };
}

/** secret scope を bucket と prefix に限定し、他の URL 要素を拒否する。 */
export function validateDuckdbS3Scope(rawScope: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawScope);
  } catch (error) {
    throw new Error('DuckDB S3 secret scope must be an s3 URI', { cause: error });
  }
  if (
    parsed.protocol !== 's3:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname === '/' ||
    !parsed.pathname.endsWith('/')
  ) {
    throw new Error('DuckDB S3 secret scope must be an s3://bucket/prefix/ URI');
  }
  return parsed.toString();
}

/** parameter binding 用の temporary credential_chain secret 文を作る。 */
export function buildDuckdbS3TemporarySecret(
  input: DuckdbS3TemporarySecretInput,
): DuckdbS3SecretStatement {
  const name = validateIdentifier(input.name);
  const scope = validateDuckdbS3Scope(input.scope);
  const endpoint = parseDuckdbS3Endpoint(input.endpoint);
  if (input.region.trim() === '') throw new Error('DuckDB S3 secret region must not be empty');
  if (input.sessionToken !== undefined && input.sessionToken.trim() === '') {
    throw new Error('DuckDB S3 secret session token must not be empty');
  }

  const clauses = [
    `CREATE OR REPLACE TEMPORARY SECRET ${name} (TYPE S3`,
    'PROVIDER CREDENTIAL_CHAIN',
    "CHAIN 'env'",
    'REGION ?',
    ...(endpoint.host === undefined ? [] : ['ENDPOINT ?']),
    'URL_STYLE ?',
    'USE_SSL ?',
    ...(input.sessionToken === undefined ? [] : ['SESSION_TOKEN ?']),
    'SCOPE ?)',
  ];
  const parameters: Array<string | boolean> = [
    input.region,
    ...(endpoint.host === undefined ? [] : [endpoint.host]),
    endpoint.urlStyle,
    endpoint.useSsl,
  ];
  if (input.sessionToken !== undefined) parameters.push(input.sessionToken);
  parameters.push(scope);
  return { sql: clauses.join(', '), parameters };
}

/** fresh DuckDB instance の処理単位で temporary secret を作る。 */
export async function createDuckdbS3TemporarySecret(
  connection: DuckDBConnection,
  input: DuckdbS3TemporarySecretInput,
): Promise<void> {
  const statement = buildDuckdbS3TemporarySecret(input);
  await connection.run(statement.sql, statement.parameters);
}

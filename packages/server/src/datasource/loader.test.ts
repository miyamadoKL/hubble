import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDatasources } from './loader';

function writeDatasources(dir: string, body: string): string {
  const path = join(dir, 'datasources.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('loadDatasources', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-ds-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads trino, mysql, and postgresql entries from YAML', () => {
    const mysqlPassPath = join(tempDir, 'mysql-pass');
    writeFileSync(mysqlPassPath, 'mysql-pass\n', 'utf8');

    const yamlPath = writeDatasources(
      tempDir,
      `datasources:
  - id: trino-prod
    type: trino
    displayName: Production Trino
    username: trino-user
    passwordEnv: TRINO_SECRET
    baseUrl: http://trino:8080
    source: custom-source
  - id: mysql-analytics
    type: mysql
    username: mysql-user
    passwordFile: ${mysqlPassPath}
    host: mysql.internal
    database: analytics
  - id: pg-warehouse
    type: postgresql
    username: pg-user
    host: postgres.internal
    port: 5433
    database: warehouse
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: yamlPath, TRINO_SECRET: 'trino-pass' },
      cwd: tempDir,
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      id: 'trino-prod',
      type: 'trino',
      displayName: 'Production Trino',
      username: 'trino-user',
      password: 'trino-pass',
      baseUrl: 'http://trino:8080',
      source: 'custom-source',
      // metadataSource/scheduledSource は YAML 未指定のため既定値が埋まる。
      metadataSource: 'hubble-metadata',
      scheduledSource: 'hubble-scheduled',
    });
    expect(result[1]).toEqual({
      id: 'mysql-analytics',
      type: 'mysql',
      displayName: 'mysql-analytics',
      username: 'mysql-user',
      password: 'mysql-pass',
      host: 'mysql.internal',
      port: 3306,
      database: 'analytics',
      readOnly: true,
      tls: false,
      maxConnections: 5,
    });
    expect(result[2]).toEqual({
      id: 'pg-warehouse',
      type: 'postgresql',
      displayName: 'pg-warehouse',
      username: 'pg-user',
      password: '',
      host: 'postgres.internal',
      port: 5433,
      database: 'warehouse',
      readOnly: true,
      tls: false,
      maxConnections: 5,
    });
  });

  it('rejects duplicate ids', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    baseUrl: http://trino:8080
  - id: trino-a
    type: trino
    username: u
    baseUrl: http://trino:8081
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow("datasource 'trino-a': duplicate id");
  });

  it('rejects invalid id format', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: Trino-Prod
    type: trino
    username: u
    baseUrl: http://trino:8080
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/datasources\[0\]\.id/);
  });

  it('rejects passwordEnv and passwordFile together', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    passwordEnv: PASS
    passwordFile: /tmp/pass
    baseUrl: http://trino:8080
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/passwordEnv/);
  });

  it('rejects missing trino baseUrl', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/datasources\[0\]/);
  });

  it('rejects missing mysql database', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: mysql-a
    type: mysql
    username: u
    host: localhost
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/datasources\[0\]/);
  });

  it('rejects missing postgresql host', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: pg-a
    type: postgresql
    username: u
    database: app
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/datasources\[0\]/);
  });

  it('resolves passwordEnv when set', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    passwordEnv: MY_PASS
    baseUrl: http://trino:8080
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: 'datasources.yaml', MY_PASS: 'from-env' },
      cwd: tempDir,
    });

    expect(result[0]?.password).toBe('from-env');
  });

  it('errors when passwordEnv is unset', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    passwordEnv: MISSING_PASS
    baseUrl: http://trino:8080
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow("datasource 'trino-a': passwordEnv 'MISSING_PASS' is not set");
  });

  it('reads passwordFile and trims trailing newline', () => {
    const passPath = join(tempDir, 'pass.txt');
    writeFileSync(passPath, 'file-secret\n', 'utf8');
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    passwordFile: ${passPath}
    baseUrl: http://trino:8080
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });

    expect(result[0]?.password).toBe('file-secret');
  });

  it('reads passwordFile and trims trailing CRLF', () => {
    const passPath = join(tempDir, 'pass-crlf.txt');
    writeFileSync(passPath, 'crlf-secret\r\n', 'utf8');
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    passwordFile: ${passPath}
    baseUrl: http://trino:8080
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });

    expect(result[0]?.password).toBe('crlf-secret');
  });

  it('errors when passwordFile cannot be read', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    passwordFile: /no/such/file
    baseUrl: http://trino:8080
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow("datasource 'trino-a': passwordFile '/no/such/file' cannot be read");
  });

  it('throws a clear error when datasources.yaml does not exist (no fallback)', () => {
    // Postgres ファースト移行により、TRINO_* 環境変数から trino-default
    // データソースを自動合成する後方互換フォールバックは廃止された。
    // DATASOURCES_PATH 未指定かつ ./datasources.yaml も無い場合は起動時エラーにする。
    expect(() =>
      loadDatasources({
        env: {},
        cwd: tempDir,
      }),
    ).toThrow(
      'datasources.yaml が見つからない。DATASOURCES_PATH で指定するか ./datasources.yaml を作成せよ',
    );
  });

  it('resolves explicit metadataSource/scheduledSource for a trino datasource', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    baseUrl: http://trino:8080
    source: custom-source
    metadataSource: custom-metadata
    scheduledSource: custom-scheduled
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });

    expect(result[0]).toMatchObject({
      source: 'custom-source',
      metadataSource: 'custom-metadata',
      scheduledSource: 'custom-scheduled',
    });
  });

  it('defaults source/metadataSource/scheduledSource when omitted for a trino datasource', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    baseUrl: http://trino:8080
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });

    expect(result[0]).toMatchObject({
      source: 'hubble',
      metadataSource: 'hubble-metadata',
      scheduledSource: 'hubble-scheduled',
    });
  });

  it('rejects an empty metadataSource string', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: u
    baseUrl: http://trino:8080
    metadataSource: ''
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/datasources\[0\]\.metadataSource/);
  });

  it('resolves mysql/postgresql connection options from YAML', () => {
    const caPath = join(tempDir, 'ca.pem');
    writeFileSync(caPath, '-----BEGIN CERT-----\n', 'utf8');
    writeDatasources(
      tempDir,
      `datasources:
  - id: mysql-a
    type: mysql
    username: u
    host: localhost
    database: app
    readOnly: false
    tls: true
    tlsCaFile: ${caPath}
    maxConnections: 10
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });

    expect(result[0]).toMatchObject({
      id: 'mysql-a',
      readOnly: false,
      tls: true,
      tlsCa: '-----BEGIN CERT-----\n',
      maxConnections: 10,
    });
  });

  it('rejects tlsCaFile without tls: true', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: mysql-a
    type: mysql
    username: u
    host: localhost
    database: app
    tlsCaFile: /tmp/ca.pem
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/tlsCaFile requires tls: true/);
  });

  it('errors when DATASOURCES_PATH points to a missing file', () => {
    // DATASOURCES_PATH で明示指定したパスが存在しない場合も、既定パス探索が
    // 失敗した場合と同じ「datasources.yaml が見つからない」必須化エラーになる。
    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'missing.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(
      'datasources.yaml が見つからない。DATASOURCES_PATH で指定するか ./datasources.yaml を作成せよ',
    );
  });

  it('resolves mysql and postgresql roleCredentials from env and files', () => {
    const pgAnalystPassPath = join(tempDir, 'pg-analyst-pass');
    writeFileSync(pgAnalystPassPath, 'pg-analyst-pass\n', 'utf8');
    writeDatasources(
      tempDir,
      `datasources:
  - id: mysql-a
    type: mysql
    username: mysql-default
    host: mysql.internal
    database: analytics
    roleCredentials:
      analyst:
        username: mysql-analyst
        passwordEnv: MYSQL_ANALYST_PASS
  - id: pg-a
    type: postgresql
    username: pg-default
    host: pg.internal
    database: app
    roleCredentials:
      analyst:
        username: pg-analyst
        passwordFile: ${pgAnalystPassPath}
`,
    );

    const result = loadDatasources({
      env: { DATASOURCES_PATH: 'datasources.yaml', MYSQL_ANALYST_PASS: 'mysql-analyst-pass' },
      cwd: tempDir,
    });

    expect(result[0]).toMatchObject({
      roleCredentials: {
        analyst: { username: 'mysql-analyst', password: 'mysql-analyst-pass' },
      },
    });
    expect(result[1]).toMatchObject({
      roleCredentials: {
        analyst: { username: 'pg-analyst', password: 'pg-analyst-pass' },
      },
    });
  });

  it('rejects literal password fields in datasource YAML', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: mysql-a
    type: mysql
    username: u
    password: plain-text
    host: localhost
    database: app
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/password/);
  });

  it('rejects literal password fields in roleCredentials YAML', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: mysql-a
    type: mysql
    username: u
    host: localhost
    database: app
    roleCredentials:
      analyst:
        username: analyst
        password: plain-text
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml' },
        cwd: tempDir,
      }),
    ).toThrow(/roleCredentials/);
  });

  it('rejects misspelled datasource fields instead of dropping them', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: mysql-a
    type: mysql
    username: u
    host: localhost
    database: app
    roleCredentails:
      analyst:
        username: analyst
        passwordEnv: ANALYST_PASSWORD
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml', ANALYST_PASSWORD: 'secret' },
        cwd: tempDir,
      }),
    ).toThrow(/roleCredentails/);
  });

  it('rejects unknown fields in role credential values and the root object', () => {
    writeDatasources(
      tempDir,
      `datasources:
  - id: pg-a
    type: postgresql
    username: u
    host: localhost
    database: app
    roleCredentials:
      analyst:
        username: analyst
        passwordEnv: ANALYST_PASSWORD
        usernmae: typo
unknownRoot: true
`,
    );

    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'datasources.yaml', ANALYST_PASSWORD: 'secret' },
        cwd: tempDir,
      }),
    ).toThrow(/usernmae|unknownRoot/);
  });
});

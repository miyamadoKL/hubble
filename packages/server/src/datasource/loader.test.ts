import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDatasources } from './loader';
import type { ServerConfig } from '../config';

const trinoConfig: ServerConfig['trino'] = {
  baseUrl: 'http://trino.example:8080',
  username: 'admin',
  password: 'secret-from-env',
  user: 'admin',
  source: 'hubble',
  metadataSource: 'hubble-metadata',
  scheduledSource: 'hubble-scheduled',
};

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
      trino: trinoConfig,
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
        trino: trinoConfig,
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
        trino: trinoConfig,
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
        trino: trinoConfig,
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
        trino: trinoConfig,
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
        trino: trinoConfig,
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
        trino: trinoConfig,
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
      trino: trinoConfig,
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
        trino: trinoConfig,
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
      trino: trinoConfig,
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
      trino: trinoConfig,
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
        trino: trinoConfig,
        cwd: tempDir,
      }),
    ).toThrow("datasource 'trino-a': passwordFile '/no/such/file' cannot be read");
  });

  it('falls back to TRINO_* config when no datasources file exists', () => {
    const result = loadDatasources({
      env: {},
      trino: trinoConfig,
      cwd: tempDir,
    });

    expect(result).toEqual([
      {
        id: 'trino-default',
        type: 'trino',
        displayName: 'Trino',
        username: 'admin',
        password: 'secret-from-env',
        baseUrl: 'http://trino.example:8080',
        source: 'hubble',
      },
    ]);
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
      trino: trinoConfig,
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
        trino: trinoConfig,
        cwd: tempDir,
      }),
    ).toThrow(/tlsCaFile requires tls: true/);
  });

  it('errors when DATASOURCES_PATH points to a missing file', () => {
    expect(() =>
      loadDatasources({
        env: { DATASOURCES_PATH: 'missing.yaml' },
        trino: trinoConfig,
        cwd: tempDir,
      }),
    ).toThrow("datasources file '");
  });
});

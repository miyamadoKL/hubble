/**
 * MinIO 上の A1 Parquet artifact を DuckDB の credential chain で読む gate runner。
 *
 * bucket の作成と policy user の bootstrap だけが管理者 credential を使う。
 * artifact の upload、stat、直接 read は scoped user の credential を使う。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { DuckDBInstance } from '@duckdb/node-api';
import type { QueryColumn } from '@hubble/contracts';
import { S3ResultStore } from './s3';
import { convertJsonlToParquet } from './parquetConverter';
import {
  createDuckdbS3TemporarySecret,
  parseDuckdbS3Endpoint,
  type DuckdbS3Endpoint,
} from './duckdbS3';

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface DuckdbS3GateConfig {
  endpointUrl: string;
  endpoint: DuckdbS3Endpoint;
  region: string;
  bucket: string;
  bootstrapCredentials: AwsCredentials;
  writerCredentials: AwsCredentials;
  readerCredentials: AwsCredentials;
}

export interface DuckdbS3GateMetrics {
  duckdb: string;
  extension: string;
  resultObjectBytes: number;
  rowCount: number;
  projectionRows: number;
  filteredRows: number;
  rowGroups: number;
  badCredentialRejected: boolean;
  rangeObservation: string;
}

const GATE_PREFIX = 'gate/';
const GATE_BUCKET = 'hubble-duckdb-s3-gate';

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required for the S3 gate`);
  return value;
}

function optionalCredentials(env: NodeJS.ProcessEnv, prefix: string): AwsCredentials {
  const sessionToken = env[`${prefix}_SESSION_TOKEN`]?.trim();
  return {
    accessKeyId: requiredEnv(env, `${prefix}_ACCESS_KEY_ID`),
    secretAccessKey: requiredEnv(env, `${prefix}_SECRET_ACCESS_KEY`),
    ...(sessionToken === undefined || sessionToken === '' ? {} : { sessionToken }),
  };
}

/** gate 用環境変数を読み、endpoint と credential の不足を早期に失敗させる。 */
export function loadDuckdbS3GateConfig(
  env: NodeJS.ProcessEnv = process.env,
): DuckdbS3GateConfig | undefined {
  const rawEndpoint = env.DUCKDB_S3_ENDPOINT?.trim();
  if (rawEndpoint === undefined || rawEndpoint === '') return undefined;
  return {
    endpointUrl: rawEndpoint,
    endpoint: parseDuckdbS3Endpoint(rawEndpoint),
    region: env.DUCKDB_S3_REGION?.trim() || 'us-east-1',
    bucket: GATE_BUCKET,
    bootstrapCredentials: optionalCredentials(env, 'DUCKDB_S3_BOOTSTRAP'),
    writerCredentials: optionalCredentials(env, 'DUCKDB_S3_WRITER'),
    readerCredentials: optionalCredentials(env, 'DUCKDB_S3_READER'),
  };
}

function sqlIdentifierPart(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid DuckDB secret name');
  return value;
}

function jsonlSource(columns: readonly QueryColumn[], rows: readonly unknown[][]): Readable {
  const payload = `${[
    JSON.stringify({ kind: 'columns', columns }),
    ...rows.map((row) => JSON.stringify({ kind: 'record', row })),
  ].join('\n')}\n`;
  return Readable.from(zstdCompressSync(Buffer.from(payload)));
}

async function withAwsCredentials<T>(
  credentials: AwsCredentials,
  action: () => Promise<T>,
): Promise<T> {
  const names = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
  if (credentials.sessionToken === undefined) delete process.env.AWS_SESSION_TOKEN;
  else process.env.AWS_SESSION_TOKEN = credentials.sessionToken;
  try {
    return await action();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function createBootstrapClient(config: DuckdbS3GateConfig): S3Client {
  return new S3Client({
    endpoint: config.endpointUrl,
    region: config.region,
    credentials: config.bootstrapCredentials,
    forcePathStyle: config.endpoint.host !== undefined,
  });
}

async function createParquetFixture(
  path: string,
): Promise<{ rows: unknown[][]; rowGroups: number }> {
  const rows = Array.from({ length: 15_000 }, (_, index) => [
    index,
    index % 3 === 0 ? null : `value-${index % 17}`,
    index % 2 === 0,
  ]);
  const columns: QueryColumn[] = [
    { name: 'id', type: 'integer' },
    { name: 'label', type: 'varchar' },
    { name: 'even', type: 'boolean' },
  ];
  await convertJsonlToParquet({
    source: jsonlSource(columns, rows),
    sourceFormat: 'jsonl.zst',
    columns,
    expectedRowCount: rows.length,
    outputPath: path,
  });
  return { rows, rowGroups: 2 };
}

async function readDirectFromDuckdb(
  config: DuckdbS3GateConfig,
  credentials: AwsCredentials,
  objectUri: string,
  secretName: string,
): Promise<{
  rowCount: number;
  projectionRows: unknown[][];
  filteredRows: unknown[][];
  rowGroups: number;
}> {
  return withAwsCredentials(credentials, async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      await connection.run('SET autoload_known_extensions = false');
      await connection.run('SET autoinstall_known_extensions = false');
      await connection.run('LOAD aws');
      await connection.run('LOAD httpfs');
      await createDuckdbS3TemporarySecret(connection, {
        name: secretName,
        scope: `s3://${config.bucket}/${GATE_PREFIX}`,
        region: config.region,
        endpoint: config.endpointUrl,
        ...(credentials.sessionToken === undefined
          ? {}
          : { sessionToken: credentials.sessionToken }),
      });

      const secretReader = await connection.runAndReadAll(
        'SELECT type, provider, persistent, storage, scope FROM duckdb_secrets() WHERE name = ?',
        [secretName],
      );
      assert.deepEqual(await secretReader.getRowsJson(), [
        ['s3', 'credential_chain', false, 'memory', [`s3://${config.bucket}/${GATE_PREFIX}`]],
      ]);

      const rowCountReader = await connection.runAndReadAll(
        'SELECT count(*) FROM read_parquet(?)',
        [objectUri],
      );
      const projectionReader = await connection.runAndReadAll(
        'SELECT c0000, c0001 FROM read_parquet(?) ORDER BY c0000 LIMIT 3',
        [objectUri],
      );
      const filteredReader = await connection.runAndReadAll(
        'SELECT c0000, c0001 FROM read_parquet(?) WHERE c0000 BETWEEN ? AND ? ORDER BY c0000',
        [objectUri, 7000, 7002],
      );
      const metadataReader = await connection.runAndReadAll(
        'SELECT count(DISTINCT row_group_id) FROM parquet_metadata(?)',
        [objectUri],
      );
      return {
        rowCount: Number((await rowCountReader.getRowsJson())[0]?.[0]),
        projectionRows: await projectionReader.getRowsJson(),
        filteredRows: await filteredReader.getRowsJson(),
        rowGroups: Number((await metadataReader.getRowsJson())[0]?.[0]),
      };
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }
  });
}

/** MinIO gate を実行し、credential と query の結果だけを安全な metrics で返す。 */
export async function runDuckdbS3Gate(config: DuckdbS3GateConfig): Promise<DuckdbS3GateMetrics> {
  const directory = mkdtempSync(join(tmpdir(), 'hubble-duckdb-s3-gate-'));
  const fixturePath = join(directory, 'result.parquet');
  const key = `${GATE_PREFIX}${process.pid}-${Date.now()}/result.parquet`;
  const secretName = sqlIdentifierPart(`gate_secret_${process.pid}_${Date.now()}`);
  const objectUri = `s3://${config.bucket}/${key}`;
  const adminClient = createBootstrapClient(config);
  let bucketCreated = false;
  let objectUploaded = false;
  try {
    const fixture = await createParquetFixture(fixturePath);
    await adminClient.send(new CreateBucketCommand({ Bucket: config.bucket }));
    bucketCreated = true;

    await withAwsCredentials(config.writerCredentials, async () => {
      const writerStore = new S3ResultStore({
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpointUrl,
      });
      try {
        await writerStore.put(key, Readable.from(readFileSync(fixturePath)), 'parquet');
        objectUploaded = true;
      } finally {
        await writerStore.close();
      }
    });

    const storedSize = await withAwsCredentials(config.readerCredentials, async () => {
      const readerStore = new S3ResultStore({
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpointUrl,
      });
      try {
        return (await readerStore.stat(key)).size;
      } finally {
        await readerStore.close();
      }
    });

    const valid = await readDirectFromDuckdb(
      config,
      config.readerCredentials,
      objectUri,
      secretName,
    );
    assert.equal(valid.rowCount, fixture.rows.length);
    assert.deepEqual(valid.projectionRows, [
      [0, null],
      [1, 'value-1'],
      [2, 'value-2'],
    ]);
    assert.deepEqual(valid.filteredRows, [
      [7000, 'value-13'],
      [7001, 'value-14'],
      [7002, null],
    ]);
    assert.equal(valid.rowGroups, fixture.rowGroups);

    let badCredentialRejected = false;
    try {
      await readDirectFromDuckdb(
        config,
        { accessKeyId: 'invalid-gate-key', secretAccessKey: 'invalid-gate-secret' },
        objectUri,
        `${secretName}_bad`,
      );
    } catch {
      badCredentialRejected = true;
    }
    assert.equal(badCredentialRejected, true);
    return {
      duckdb: '1.5.4-r.1',
      extension:
        'aws and httpfs loaded from the baked extension directory with autoload/install disabled',
      resultObjectBytes: storedSize,
      rowCount: valid.rowCount,
      projectionRows: valid.projectionRows.length,
      filteredRows: valid.filteredRows.length,
      rowGroups: valid.rowGroups,
      badCredentialRejected,
      rangeObservation: 'informational only; MinIO access log is not a stable Range oracle',
    };
  } finally {
    if (objectUploaded) {
      await withAwsCredentials(config.writerCredentials, async () => {
        const writerStore = new S3ResultStore({
          bucket: config.bucket,
          region: config.region,
          endpoint: config.endpointUrl,
        });
        try {
          await writerStore.delete(key);
        } finally {
          await writerStore.close();
        }
      });
    }
    if (bucketCreated) await adminClient.send(new DeleteBucketCommand({ Bucket: config.bucket }));
    adminClient.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
}

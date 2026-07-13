import { existsSync, rmSync } from 'node:fs';
import process from 'node:process';
import { log } from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

if (process.getuid?.() === 0) {
  throw new Error('Parquet production smoke must run as the non-root node user');
}

const outputPath = join(tmpdir(), `hubble-parquet-smoke-${process.pid}.parquet`);
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
let instance;
let connection;
let appender;

try {
  instance = await DuckDBInstance.create(':memory:', {
    threads: '1',
    memory_limit: '64MB',
    temp_directory: '/tmp',
    max_temp_directory_size: '128MB',
  });
  connection = await instance.connect();
  await connection.run('CREATE TABLE smoke_input (c0000 INTEGER, c0001 VARCHAR)');
  appender = await connection.createAppender('smoke_input');
  appender.appendInteger(7);
  appender.appendVarchar('node-user');
  appender.endRow();
  appender.appendNull();
  appender.appendVarchar('zstd');
  appender.endRow();
  appender.flushSync();
  appender.closeSync();
  appender = undefined;

  await connection.run(
    `COPY smoke_input TO ${sqlString(outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD, KV_METADATA {'hubble.encoding_version':'1','hubble.row_count':'2'})`,
  );
  const rowsReader = await connection.runAndReadAll(
    `SELECT * FROM read_parquet(${sqlString(outputPath)}) ORDER BY c0000 NULLS LAST`,
  );
  const rows = await rowsReader.getRowsJson();
  if (rows.length !== 2 || rows[0]?.[0] !== 7 || rows[0]?.[1] !== 'node-user') {
    throw new Error(`Unexpected Parquet read-back rows: ${JSON.stringify(rows)}`);
  }
  const metadataReader = await connection.runAndReadAll(
    `SELECT key, value FROM parquet_kv_metadata(${sqlString(outputPath)})`,
  );
  const metadata = await metadataReader.getRowsJson();
  if (
    !metadata.some((row) => row[0] === 'hubble.encoding_version' && row[1] === '1') ||
    !metadata.some((row) => row[0] === 'hubble.row_count' && row[1] === '2')
  ) {
    throw new Error(`Unexpected Parquet metadata: ${JSON.stringify(metadata)}`);
  }
  log('Parquet production smoke passed');
} finally {
  try {
    appender?.closeSync();
  } catch {
    // smoke の失敗を close error で隠さない。
  }
  try {
    connection?.disconnectSync();
  } catch {
    // instance の close を続ける。
  }
  try {
    instance?.closeSync();
  } catch {
    // smoke の本体エラーを close error で隠さない。
  }
  if (existsSync(outputPath)) rmSync(outputPath, { force: true });
}

import { describe, expect, it } from 'vitest';
import { loadDuckdbS3GateConfig, runDuckdbS3Gate } from './duckdbS3Gate';

const config = loadDuckdbS3GateConfig();

describe.skipIf(config === undefined)('DuckDB direct S3 credential gate', () => {
  it('reads an A1-compatible Parquet artifact through ResultStore and credential_chain', async () => {
    const metrics = await runDuckdbS3Gate(config as NonNullable<typeof config>);
    expect(metrics).toMatchObject({
      duckdb: '1.5.4-r.1',
      extension: expect.stringContaining('aws and httpfs'),
      rowCount: 15_000,
      projectionRows: 3,
      filteredRows: 3,
      rowGroups: 2,
      badCredentialRejected: true,
      productReaderRowCount: 15_000,
      productReaderColumns: 3,
    });
    console.info('DuckDB S3 gate metrics', metrics);
  });
});

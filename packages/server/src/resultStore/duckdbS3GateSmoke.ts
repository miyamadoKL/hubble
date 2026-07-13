import { loadDuckdbS3GateConfig, runDuckdbS3Gate } from './duckdbS3Gate';

const config = loadDuckdbS3GateConfig();
if (config === undefined) throw new Error('DUCKDB_S3_ENDPOINT is required for the production gate');

console.info('DuckDB S3 production gate metrics', await runDuckdbS3Gate(config));

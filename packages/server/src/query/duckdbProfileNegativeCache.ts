import { createHash } from 'node:crypto';
import type { DuckdbProfileFailureCode, DuckdbProfileInput } from '../resultStore';

/** capability として短時間 cache できる profile failure。 */
export type DuckdbProfileNegativeCapabilityCode = Extract<
  DuckdbProfileFailureCode,
  'auth' | 'httpfs' | 'schema_mismatch'
>;

/** profile DuckDB capability の negative cache。 */
export interface DuckdbProfileNegativeCapabilityCache {
  get(key: string): DuckdbProfileNegativeCapabilityCode | undefined;
  remember(key: string, code: DuckdbProfileNegativeCapabilityCode): void;
  clear(): void;
}

interface NegativeEntry {
  code: DuckdbProfileNegativeCapabilityCode;
  expiresAt: number;
}

/** credential と endpoint の capability を secret なしで識別する。 */
export function duckdbProfileCapabilityKey(input: DuckdbProfileInput): string {
  return JSON.stringify({
    provider: 'env',
    endpoint: input.endpoint ?? 'aws-default',
    region: input.region ?? 'us-east-1',
    bucket: input.bucket,
    prefix: input.prefix,
  });
}

/** schema mismatch だけに使う object 単位の安全な cache key を作る。 */
export function duckdbProfileObjectCapabilityKey(input: DuckdbProfileInput): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        provider: 'env',
        endpoint: input.endpoint ?? 'aws-default',
        region: input.region ?? 'us-east-1',
        bucket: input.bucket,
        prefix: input.prefix,
        objectKey: input.objectKey,
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return 'object:' + digest;
}

/** process 内だけで使う bounded negative cache。 */
export class InMemoryDuckdbProfileNegativeCapabilityCache implements DuckdbProfileNegativeCapabilityCache {
  private readonly entries = new Map<string, NegativeEntry>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 256,
    private readonly now = Date.now,
    private readonly schemaMismatchTtlMs = 10_000,
  ) {}

  get(key: string): DuckdbProfileNegativeCapabilityCode | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.code;
  }

  remember(key: string, code: DuckdbProfileNegativeCapabilityCode): void {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(key);
    const ttlMs = code === 'schema_mismatch' ? this.schemaMismatchTtlMs : this.ttlMs;
    if (ttlMs <= 0) return;
    this.entries.set(key, { code, expiresAt: this.now() + ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

import { createHash } from 'node:crypto';
import { RESULT_STORE_MAX_RANGE_BYTES, type ResultStoreRequestOptions } from '../resultStore/store';

/** 保存内容から、上書きを検出できるインメモリ validator を作る。 */
export function memoryResultStoreValidator(data: Buffer): string {
  return `"${createHash('sha256').update(data).digest('hex')}"`;
}

/** 保存内容から、S3 の VersionId に相当するインメモリ識別子を作る。 */
export function memoryResultStoreVersionId(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** インメモリ fake の読み取り条件を検証する。 */
export function validateMemoryResultRequest(
  key: string,
  data: Buffer,
  options: ResultStoreRequestOptions | undefined,
): void {
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new Error(`Result store request aborted: ${key}`);
  }
  const validator = options?.validator;
  if (validator !== undefined && validator !== memoryResultStoreValidator(data)) {
    throw new Error(`Result store validator mismatch: ${key}`);
  }
  const versionId = options?.versionId;
  if (versionId !== undefined && versionId !== memoryResultStoreVersionId(data)) {
    throw new Error(`Result store version mismatch: ${key}`);
  }
}

/** インメモリ fake で保存済み raw bytes の範囲を読む。 */
export function readMemoryResultRange(
  key: string,
  data: Buffer,
  offset: number,
  length: number,
  options?: ResultStoreRequestOptions,
): Buffer {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Invalid range offset for ${key}: ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`Invalid range length for ${key}: ${length}`);
  }
  if (length > RESULT_STORE_MAX_RANGE_BYTES) {
    throw new Error(`Result store range length exceeds maximum for ${key}: ${length}`);
  }
  if (offset > Number.MAX_SAFE_INTEGER - length) {
    throw new Error(`Invalid range overflow for ${key}: offset=${offset}, length=${length}`);
  }
  validateMemoryResultRequest(key, data, options);
  if (offset + length > data.length) {
    throw new Error(`short range: ${key}`);
  }
  return Buffer.from(data.subarray(offset, offset + length));
}

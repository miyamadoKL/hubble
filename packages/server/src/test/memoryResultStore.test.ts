import { describe, expect, it } from 'vitest';
import {
  memoryResultStoreValidator,
  memoryResultStoreVersionId,
  readMemoryResultRange,
} from './memoryResultStore';
import { RESULT_STORE_MAX_RANGE_BYTES } from '../resultStore/store';

describe('memory ResultStore helper', () => {
  const key = 'result.jsonl.zst';
  const data = Buffer.from('0123456789');

  it('reads exact ranges and accepts the current validator and versionId', () => {
    const validator = memoryResultStoreValidator(data);
    const versionId = memoryResultStoreVersionId(data);

    expect(readMemoryResultRange(key, data, 2, 4, { validator, versionId })).toEqual(
      Buffer.from('2345'),
    );
  });

  it('rejects stale validators after an overwrite', () => {
    const staleValidator = memoryResultStoreValidator(data);
    const overwritten = Buffer.from('abcdefghij');

    expect(() =>
      readMemoryResultRange(key, overwritten, 0, 2, { validator: staleValidator }),
    ).toThrow(/validator mismatch/);
  });

  it('rejects a wrong versionId', () => {
    expect(() => readMemoryResultRange(key, data, 0, 2, { versionId: 'wrong-version' })).toThrow(
      /version mismatch/,
    );
  });

  it('preserves an already aborted request reason', () => {
    const abortError = new Error('request aborted');
    abortError.name = 'AbortError';
    const controller = new AbortController();
    controller.abort(abortError);

    expect(() => readMemoryResultRange(key, data, 0, 1, { signal: controller.signal })).toThrow(
      abortError,
    );
  });

  it('checks range shape before an already aborted request', () => {
    const controller = new AbortController();
    controller.abort(new Error('request aborted'));

    expect(() => readMemoryResultRange(key, data, -1, 1, { signal: controller.signal })).toThrow(
      /range offset/,
    );
  });

  it('rejects invalid ranges, overflow, and the configured maximum', () => {
    expect(() => readMemoryResultRange(key, data, -1, 1)).toThrow(/range offset/);
    expect(() => readMemoryResultRange(key, data, 0, 0)).toThrow(/range length/);
    expect(() => readMemoryResultRange(key, data, Number.MAX_SAFE_INTEGER, 2)).toThrow(
      /range overflow/,
    );
    expect(() => readMemoryResultRange(key, data, 0, RESULT_STORE_MAX_RANGE_BYTES + 1)).toThrow(
      /exceeds maximum/,
    );
  });

  it('rejects a range extending past EOF instead of shortening it', () => {
    expect(() => readMemoryResultRange(key, data, 8, 3)).toThrow(/short range/);
  });
});

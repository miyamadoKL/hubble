/**
 * ResultStore の生成エントリーポイント。
 */
import type { ServerConfig } from '../config';
import { NoneResultStore, type ResultStore } from './store';
import { S3ResultStore, type S3ResultStoreDeps } from './s3';

export {
  NoneResultStore,
  RESULT_STORE_MAX_RANGE_BYTES,
  ResultStoreError,
  type ResultStore,
  type ResultArtifactFormat,
  type ResultStoreErrorCode,
  type ResultStoreErrorOptions,
  type ResultStoreOperation,
  type ResultStoreRequestOptions,
  type ResultStoreStat,
} from './store';
export { S3ResultStore, buildS3ClientConfig, resultArtifactMetadata } from './s3';
export {
  convertJsonlToParquet,
  ParquetConverterError,
  type ParquetConverterErrorCode,
  type ParquetConverterInput,
  type ParquetConverterResourceLimits,
  type ParquetConverterResult,
} from './parquetConverter';

/** ResultStore 生成時の注入ポイント。 */
export interface CreateResultStoreDeps {
  s3?: S3ResultStoreDeps;
}

/** 設定から ResultStore 実装を生成する。 */
export function createResultStore(
  config: ServerConfig['resultStore'],
  deps: CreateResultStoreDeps = {},
): ResultStore {
  if (config.kind === 'none') return new NoneResultStore();
  return new S3ResultStore(
    {
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint,
    },
    deps.s3,
  );
}

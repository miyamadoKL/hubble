/**
 * データソース ID の解決ヘルパー。
 */
import { AppError } from '../errors';
import type { QueryEngine } from './types';

/**
 * リクエストの datasourceId を解決し、対応するエンジンを返す。
 * 省略時は defaultDatasourceId を使う。未知の id は 404。
 *
 * @param engines - 構築済みエンジンマップ。
 * @param requestedId - リクエストで指定された id（省略可）。
 * @param defaultDatasourceId - 設定順先頭の既定 id。
 * @returns 解決済み id とエンジン。
 */
export function resolveEngine(
  engines: Map<string, QueryEngine>,
  requestedId: string | undefined,
  defaultDatasourceId: string,
): { datasourceId: string; engine: QueryEngine } {
  const datasourceId = requestedId ?? defaultDatasourceId;
  const engine = engines.get(datasourceId);
  if (!engine) {
    throw AppError.notFound(`Datasource ${datasourceId} not found`);
  }
  return { datasourceId, engine };
}

/**
 * スケジュール実行時にエンジンを取得する。永続化済み id が yaml から消えていたら undefined。
 *
 * @param engines - 構築済みエンジンマップ。
 * @param datasourceId - スケジュールに保存された id。
 * @returns エンジン、または未設定時は undefined。
 */
export function getEngineOrUndefined(
  engines: Map<string, QueryEngine>,
  datasourceId: string,
): QueryEngine | undefined {
  return engines.get(datasourceId);
}
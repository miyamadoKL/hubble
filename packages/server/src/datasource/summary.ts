/**
 * 解決済みデータソースから API 公開用サマリーを組み立てる。
 */
import type { DatasourceSummary } from '@hubble/contracts';
import type { ResolvedDatasource } from './types';

/**
 * kind から capabilities を導出する。
 * @param kind - データソース種別。
 * @returns クライアント向け機能フラグ。
 */
export function capabilitiesForKind(kind: ResolvedDatasource['type']): DatasourceSummary['capabilities'] {
  switch (kind) {
    case 'trino':
      return { costEstimate: true, catalogs: true };
    case 'mysql':
    case 'postgresql':
      return { costEstimate: false, catalogs: false };
  }
}

/**
 * 解決済みデータソースを API サマリーに変換する（秘匿情報は含めない）。
 * @param datasource - 解決済みデータソース。
 * @returns `GET /api/datasources` 用の 1 件分サマリー。
 */
export function toDatasourceSummary(datasource: ResolvedDatasource): DatasourceSummary {
  return {
    id: datasource.id,
    kind: datasource.type,
    displayName: datasource.displayName,
    capabilities: capabilitiesForKind(datasource.type),
  };
}

/**
 * 解決済みデータソース配列を API サマリー配列に変換する（YAML の記述順を保つ）。
 * @param datasources - 解決済みデータソース一覧。
 * @returns 公開サマリー一覧。
 */
export function toDatasourceSummaries(datasources: ResolvedDatasource[]): DatasourceSummary[] {
  return datasources.map(toDatasourceSummary);
}

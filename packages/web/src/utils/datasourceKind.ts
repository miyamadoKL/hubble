/**
 * データソース kind の表示用バッジ情報。
 */
import type { DatasourceKind } from '@hubble/contracts';

/** kind ごとの短い表示ラベル。 */
export const DATASOURCE_KIND_LABEL: Record<DatasourceKind, string> = {
  trino: 'Trino',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
};

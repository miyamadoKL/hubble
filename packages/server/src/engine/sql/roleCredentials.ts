/**
 * RBAC ロールに紐づく SQL 接続 credential（role credential）の選択ロジック。
 *
 * ロールごとに DB 側の権限を分けたい場合、データソース設定の roleCredentials
 * にロール名で接続情報を登録できる。この選択結果の poolKey は
 * mysql/engine.ts と postgresql/engine.ts の poolForRole がロールごとの
 * コネクションプールを分離するためのキーとして使う(statementClient.ts は
 * 既に選択済みの pool を受け取るだけで、この関数を直接呼ばない)。
 * Trino は別経路（X-Trino-User によるなりすまし）で credential を扱うため、
 * ioExplainExecution を実装するのは trino.ts のみで、selectSqlCredential は
 * 経由しない。
 */
import type { ResolvedSqlRoleCredential } from '../../datasource/types';

/** roleCredentials を持つ SQL データソースの最小形。 */
interface SqlRoleCredentialSource {
  username: string;
  password: string;
  roleCredentials?: Record<string, ResolvedSqlRoleCredential>;
}

/** 選択済み credential と対応する pool キー。 */
export interface SelectedSqlCredential {
  /** pool Map で使うキー。role credential 未使用時は固定値。 */
  poolKey: string;
  /** 接続用ユーザー名。 */
  username: string;
  /** 解決済みパスワード。 */
  password: string;
}

const DEFAULT_POOL_KEY = '__default__';

/**
 * RBAC role 名から SQL 接続 credential を選ぶ。
 * roleCredentials に対応 role が無ければデータソース既定 credential に戻す。
 */
export function selectSqlCredential(
  datasource: SqlRoleCredentialSource,
  roleName: string | undefined,
): SelectedSqlCredential {
  if (roleName !== undefined) {
    const credential = datasource.roleCredentials?.[roleName];
    if (credential !== undefined) {
      return {
        poolKey: roleName,
        username: credential.username,
        password: credential.password,
      };
    }
  }
  return {
    poolKey: DEFAULT_POOL_KEY,
    username: datasource.username,
    password: datasource.password,
  };
}

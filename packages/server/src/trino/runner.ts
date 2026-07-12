import type { StatementClient } from '../engine/types';
import { emptySessionMutations, type TrinoColumn, type TrinoRequestContext } from './types';
import { driveStatementPages } from '../engine/statementDriver';

/**
 * このファイルは Trino の `/v1/statement` プロトコルを「完走するまで
 * 全ページ追走し、全行をメモリに集める」形で使うための小さなヘルパー
 * `runToCompletion` を提供する。メタデータ取得 (information_schema への
 * クエリ、DESCRIBE、サンプル行取得) のように結果セットが小さいことが
 * わかっている用途向け。結果をクライアントへ都度ストリーミングしたい
 * 通常のユーザークエリ実行は、これとは別の registry (ストリーミング経路)
 * を使う。
 */

/** `runToCompletion` の戻り値: 全カラム定義と全行データ。 */
export interface TrinoQueryResult {
  columns: TrinoColumn[];
  rows: unknown[][];
}

/**
 * Run a statement to completion and collect all rows. Used for metadata queries
 * (`information_schema`, `DESCRIBE`, sample rows) where result sets are small.
 * User queries go through the streaming registry instead.
 *
 * 日本語: 処理の流れは次の通り。
 *   1. client.start() で最初のページ (通常 QUEUED) を取得する。
 *   2. ページに data があればそのまま rows に追加、columns はまだ空なら
 *      このページのものを採用する。
 *   3. page.nextUri が存在する限りループし、client.advance() で次のページを
 *      取りに行く。データが来ないページが続くとバックオフ (待ち時間) を
 *      idleAttempt に応じて増やし (client.waitBackoff)、データが来れば
 *      idleAttempt を 0 にリセットして即座に次を取りに行く。
 *   4. nextUri が無くなった時点で完了 (FINISHED)。エラー発生時は
 *      client.start/advance 内部で例外が投げられ、ここでは捕捉せず
 *      呼び出し元へ伝播する。
 */
export async function runToCompletion(
  client: StatementClient,
  statement: string,
  ctx: TrinoRequestContext,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TrinoQueryResult> {
  // 日本語: このクエリ専用のセッション変更追跡オブジェクト。runToCompletion の
  // 用途 (メタデータ取得等) では mutations の中身自体は使わないが、
  // client.start/advance のシグネチャ上必要なため生成して渡す。
  const mutations = emptySessionMutations();
  let columns: TrinoColumn[] = [];
  const rows: unknown[][] = [];
  await driveStatementPages({
    client,
    statement,
    ctx,
    mutations,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 3000,
    onPage: ({ page }) => {
      if (page.columns && columns.length === 0) columns = page.columns;
      if (page.data) rows.push(...page.data);
    },
  });
  return { columns, rows };
}

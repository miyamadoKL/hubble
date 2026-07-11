import type { StatementClient } from '../engine/types';
import { emptySessionMutations, type TrinoColumn, type TrinoRequestContext } from './types';

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
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
  timer.unref?.();
  // 日本語: このクエリ専用のセッション変更追跡オブジェクト。runToCompletion の
  // 用途 (メタデータ取得等) では mutations の中身自体は使わないが、
  // client.start/advance のシグネチャ上必要なため生成して渡す。
  const mutations = emptySessionMutations();
  let currentNextUri: string | undefined;
  try {
    let page = await client.start(statement, ctx, mutations, signal);
    currentNextUri = page.nextUri;
    let columns: TrinoColumn[] = page.columns ?? [];
    const rows: unknown[][] = [];
    if (page.data) rows.push(...page.data);

    // Same backoff discipline as the streaming loop: data pages advance with zero
    // delay; only data-less pages escalate the backoff.
    // 日本語: idleAttempt は「データの来ないページが何回連続したか」を数える。
    // データがあれば即座に (待たずに) 次を取りに行き、無ければ待ち時間を
    // 段階的に伸ばして Trino への問い合わせ頻度を抑える。
    let idleAttempt = 0;
    while (page.nextUri) {
      if (page.data && page.data.length > 0) {
        idleAttempt = 0;
      } else {
        await client.waitBackoff(idleAttempt, signal);
        idleAttempt += 1;
      }
      page = await client.advance(page.nextUri, ctx, mutations, signal);
      currentNextUri = page.nextUri;
      // 日本語: columns は最初にカラム情報を含むページ (通常 RUNNING/FINISHED の
      // 最初のデータページ) が来た時点で一度だけ確定させる。
      if (page.columns && columns.length === 0) columns = page.columns;
      if (page.data) rows.push(...page.data);
    }
    currentNextUri = undefined;
    // 日本語: page.nextUri が無くなった = クエリ完了。ここまでに集めた全行と
    // カラム定義を返す。
    return { columns, rows };
  } finally {
    clearTimeout(timer);
    if (currentNextUri) {
      await client.cancel(currentNextUri, ctx).catch(() => undefined);
    }
  }
}

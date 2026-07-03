/**
 * このファイルはクエリ実行イベントを Server-Sent Events（SSE）形式へ変換する
 * ユーティリティを提供する。
 *
 * 役割: `QueryExecution`（execution.ts）が発火する `QueryEvent`
 * （state/columns/rows/stats/error/done）を SSE フレーム文字列へ変換する
 * `encodeSseEvent`、接続維持用のキープアライブフレーム、そして SSE
 * クライアントが新規接続（あるいは再接続）した際に、実行の現在状態を
 * 一括で再現するための「リプレイイベント列」を組み立てる
 * `buildReplayEvents` を提供する。
 *
 * アーキテクチャ上の位置づけ: HTTP ルート層（担当外）が SSE エンドポイントで
 * このモジュールを利用する。まず `buildReplayEvents` で接続時点までの状態を
 * 再生し、その後は `QueryExecution.subscribe()` で受け取るライブイベントを
 * 同じく `encodeSseEvent` で都度エンコードしてクライアントへ流す想定。
 */
import type { QueryEvent } from '@hubble/contracts';
import type { QueryExecution } from './execution';

/** Serialize a `QueryEvent` as an SSE frame (`event:` + `data:` + blank line). */
// `QueryEvent` を SSE のフレーム形式（`event: <type>` 行 + `data: <JSON>` 行 +
// 空行）にシリアライズする。SSE の仕様上、イベントの区切りは空行で表される。
export function encodeSseEvent(event: QueryEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A keep-alive comment frame. */
// SSE のコメント行（`:` で始まる行はイベントとして扱われない）を使った
// キープアライブフレーム。プロキシ等によるアイドル接続の切断を防ぐために
// 定期的に送信することを想定している。
export const SSE_KEEPALIVE = ': keep-alive\n\n';

// リプレイ時にバッファ済み行を分割送信する際の 1 チャンクあたりの行数。
// 大量の行を 1 つの巨大な SSE フレームにまとめず、適度なサイズに分割する。
const ROW_CHUNK_SIZE = 500;

/**
 * Produce the replay event sequence for a freshly-connected SSE client:
 * current state, columns, buffered rows (chunked), latest stats, and — if the
 * query is already terminal — a trailing error/done. Live events follow.
 *
 * 新規接続してきた SSE クライアント向けに、それまでの実行状態を再現する
 * ためのイベント列を組み立てる: 現在の state、columns（判明していれば）、
 * バッファ済みの行（ROW_CHUNK_SIZE ごとに分割した rows イベント）、
 * 最新の stats（あれば）、そしてクエリがすでに終端状態であれば末尾に
 * error（あれば）と done を追加する。このリプレイの後、呼び出し元は
 * `QueryExecution.subscribe()` から得られるライブイベントを続けて配信する
 * ことを想定している。
 */
export function buildReplayEvents(exec: QueryExecution): QueryEvent[] {
  const events: QueryEvent[] = [];
  // まず現在の state を送る（クライアントが最初に表示すべき情報）。
  events.push({ type: 'state', state: exec.state, datasourceId: exec.datasourceId });
  // 列情報が判明していれば columns イベントを送る（まだなら省略）。
  if (exec.columns.length > 0) {
    events.push({ type: 'columns', columns: exec.columns });
  }
  // バッファ済みの全行を ROW_CHUNK_SIZE ごとに区切って rows イベントとして
  // 積む。offset を明示することでクライアント側は行の位置を正しく復元できる。
  const rows = exec.bufferedRows();
  for (let offset = 0; offset < rows.length; offset += ROW_CHUNK_SIZE) {
    events.push({ type: 'rows', offset, rows: rows.slice(offset, offset + ROW_CHUNK_SIZE) });
  }
  // 直近の統計情報があれば stats イベントとして送る。
  if (exec.stats) {
    events.push({ type: 'stats', stats: exec.stats });
  }
  // クエリがすでに終端状態に達している場合は、エラー（あれば）と done を
  // 末尾に追加し、クライアントがこれ以上ライブイベントを待たなくてよいこと
  // を伝える。
  if (exec.isTerminal) {
    if (exec.error) events.push({ type: 'error', error: exec.error });
    events.push({
      type: 'done',
      state: exec.state,
      rowCount: exec.rowCount,
      truncated: exec.truncated,
    });
  }
  return events;
}

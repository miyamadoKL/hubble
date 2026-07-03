/**
 * このファイルは Query 結果の CSV ダウンロード機能を提供する。
 *
 * 役割: `QueryExecution`（execution.ts）が保持する結果を RFC 4180 準拠の CSV
 * テキストへ変換し、AsyncGenerator としてストリーミング出力する。実行済みで
 * 全結果がバッファ済みのケースはメモリ上のバッファをそのまま再生し、
 * バッファが truncate されている（maxRows で打ち切られた）か、まだ実行中の
 * ケースでは Trino に対して同一クエリを `hubble-download` という別ソースで
 * 再実行し、行数上限なしでページを受け取りながらそのまま CSV へ変換して
 * 流す。これにより、画面表示用に制限された結果セットと、ダウンロード用の
 * 完全な結果セットを両立させている。
 *
 * アーキテクチャ上の位置づけ: HTTP ルート層（担当外）が `streamQueryCsv` を
 * 呼び出し、返された AsyncGenerator をレスポンスストリームへ接続する。
 * Trino との通信は execution.ts と同様に `TrinoClient` に委譲する。
 */
import type { StatementClient } from '../engine/types';
import { emptySessionMutations, type TrinoColumn, type TrinoRequestContext } from '../trino/types';
import type { QueryExecution } from './execution';

/** `X-Trino-Source` used by CSV re-execution queries (kept out of history). */
// CSV ダウンロードのための再実行クエリに付与するソース識別子。
// このソースを持つクエリはクエリ履歴（History）には記録されない。
export const DOWNLOAD_SOURCE = 'hubble-download';

/** RFC 4180 field quoting: quote if the value contains `,` `"` CR or LF. */
// RFC 4180 に従ったフィールドのクォート処理。カンマ、ダブルクォート、
// CR、LF のいずれかを含む場合のみクォートし、内部のダブルクォートは
// 2 重化してエスケープする。
export function csvField(value: unknown): string {
  const s = formatCell(value);
  if (s === '') return s;
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Render a single cell value to its CSV text form. */
// セルの値を CSV 用のテキスト表現へ変換する。null/undefined は空文字、
// プリミティブ型はそのまま文字列化、配列/オブジェクト（Trino の
// MAP/ARRAY/ROW/JSON 型）はコンパクトな JSON 文字列として埋め込む。
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Arrays / objects (Trino MAP/ARRAY/ROW/JSON) -> compact JSON.
  try {
    return JSON.stringify(value);
  } catch {
    // JSON.stringify が失敗するような値（循環参照など）は最終手段として
    // String() にフォールバックする。
    return String(value);
  }
}

/** Build one CSV record line (no trailing newline) from a row. */
// 1 行分のセル配列を CSV のレコード行（末尾改行なし）に変換する。
export function csvRecord(row: readonly unknown[]): string {
  return row.map(csvField).join(',');
}

/**
 * Stream a query's buffered rows as RFC 4180 CSV. If the query is still
 * running, this follows the buffer as it grows and waits for completion.
 *
 * UTF-8, no BOM, CRLF line terminators (RFC 4180). `\r\n` after every record
 * including the header. `flushEvery` rows we yield control to let the runtime
 * flush the underlying response stream.
 *
 * `QueryExecution` のバッファ済み行を RFC 4180 CSV としてストリーミングする。
 * クエリがまだ実行中の場合は、バッファが増えていくのを追随しながら完了を
 * 待つ。UTF-8、BOM なし、CRLF 改行（ヘッダ行を含む全レコードの末尾に
 * `\r\n`）。`flushEvery` 行ごとに yield して、下位のレスポンスストリームが
 * 実際にフラッシュされる機会を与える。
 */
export async function* streamCsv(
  exec: QueryExecution,
  opts: { flushEvery?: number } = {},
): AsyncGenerator<string> {
  const flushEvery = opts.flushEvery ?? 500;

  // Header is available as soon as columns are known; wait if necessary.
  // ヘッダ行は列情報（columns）が判明次第出力できる。まだ判明していなければ
  // columns イベントか終端状態のいずれかまで待つ。
  await waitForColumnsOrTerminal(exec);
  if (exec.columns.length > 0) {
    yield csvRecord(exec.columns.map((c) => c.name)) + '\r\n';
  }

  let index = 0;
  let sinceFlush = 0;
  let chunk = '';
  // Drain buffered rows, following the buffer until the query is terminal AND
  // we've emitted every buffered row.
  // バッファ済みの行を先頭から順に読み進める。クエリが終端状態に達し、かつ
  // バッファの全行を出力し終えるまでこのループを継続する。
  for (;;) {
    const row = exec.rowAt(index);
    if (row !== undefined) {
      chunk += csvRecord(row) + '\r\n';
      index += 1;
      sinceFlush += 1;
      if (sinceFlush >= flushEvery) {
        yield chunk;
        chunk = '';
        sinceFlush = 0;
      }
      continue;
    }
    // No more buffered rows at this index.
    // 現在のインデックスにはまだ行が無い。クエリが終端かつバッファの
    // 全行を消化済みならループを抜ける。
    if (exec.isTerminal && index >= exec.bufferedCount) {
      break;
    }
    // Query still running and no row yet at this index: flush and wait a tick.
    // クエリはまだ実行中で、次の行がまだバッファに届いていない場合は、
    // 溜まっているチャンクを一旦 flush してから少し待って再チェックする。
    if (chunk !== '') {
      yield chunk;
      chunk = '';
      sinceFlush = 0;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (chunk !== '') yield chunk;
}

export interface CsvDownloadDeps {
  /** Client used to issue the dedicated re-execution query (download source tag). */
  // 再実行クエリの発行に使うステートメントクライアント。
  client: StatementClient;
  /** Aborts the re-execution fetch when the HTTP client disconnects. */
  // HTTP クライアントが切断された際に再実行クエリを中断させるための signal。
  signal?: AbortSignal;
}

/**
 * Stream a query's full result as CSV.
 *
 * - When the execution is terminal and complete (`!truncated`), the buffered
 *   page store holds every row, so we replay it for free (no Trino round-trip).
 * - Otherwise (still running, or capped at maxRows) the page store is an
 *   incomplete preview. We re-run the exact statement in a fresh Trino query —
 *   same user/catalog/schema/session — and stream every received page straight
 *   to CSV with no row cap and constant memory (no page store). The re-run uses
 *   source `hubble-download` and is never recorded in query history.
 *
 * Abort (HTTP client disconnect) cancels the re-execution query via DELETE.
 *
 * クエリの「全結果」を CSV としてストリーミングするエントリポイント。
 * - 実行が終端状態かつ truncate されていない（`!truncated`）場合は、
 *   バッファ済みページストアがすでに全行を保持しているため、Trino への
 *   追加リクエストなしにそのまま再生する（streamCsv）。
 * - それ以外（まだ実行中、または maxRows で打ち切られている）場合は、
 *   バッファは不完全なプレビューに過ぎないため、同一ユーザー/カタログ/
 *   スキーマ/セッションで同一ステートメントを行数上限なしで再実行し、
 *   受信した各ページをそのまま CSV に変換してストリームする
 *   （streamCsvReexec、ページストアを持たないため定数メモリで動作）。
 *   再実行は `hubble-download` ソースを使い、クエリ履歴には記録されない。
 * - HTTP クライアントの切断（Abort）は DELETE で再実行クエリをキャンセルする。
 */
export function streamQueryCsv(
  exec: QueryExecution,
  deps: CsvDownloadDeps,
  opts: { flushEvery?: number } = {},
): AsyncGenerator<string> {
  if (exec.isTerminal && !exec.truncated) {
    return streamCsv(exec, opts);
  }
  return streamCsvReexec(exec, deps, opts);
}

/**
 * Re-execute `exec.statement` against Trino and stream every row as CSV with no
 * row cap, applying the C-1 backoff discipline (zero delay while data flows).
 *
 * `exec.statement` を Trino に対して再実行し、行数上限なしで全行を CSV として
 * ストリーミングする。execution.ts の run() と同じ C-1 バックオフ規律
 * （データが流れている間は待機ゼロ）を適用する。
 */
export async function* streamCsvReexec(
  exec: QueryExecution,
  deps: CsvDownloadDeps,
  opts: { flushEvery?: number } = {},
): AsyncGenerator<string> {
  const flushEvery = opts.flushEvery ?? 500;
  const { client, signal } = deps;
  // Inherit the original execution context but force the download source so the
  // re-run is attributable and excluded from history.
  // 元の実行コンテキストを引き継ぎつつ、ソースだけを download 用に上書きし、
  // 再実行が誰の、どのクエリの再実行なのか追跡可能にしつつ履歴からは除外する。
  const ctx: TrinoRequestContext = { ...exec.ctx, source: DOWNLOAD_SOURCE };
  const mutations = emptySessionMutations();

  let currentNextUri: string | undefined;
  let headerWritten = false;
  let chunk = '';
  let sinceFlush = 0;

  // ヘッダ行は最初に列情報を含むページが届いた時点で一度だけ書き込む。
  const writeHeader = (columns: TrinoColumn[] | undefined): void => {
    if (headerWritten || !columns || columns.length === 0) return;
    headerWritten = true;
    chunk += csvRecord(columns.map((col) => col.name)) + '\r\n';
  };

  try {
    // クエリを再実行し、最初のページを取得。
    let page = await client.start(exec.statement, ctx, mutations, signal);
    writeHeader(page.columns);
    if (page.data) {
      for (const row of page.data) {
        chunk += csvRecord(row) + '\r\n';
        sinceFlush += 1;
      }
    }

    // nextUri がある限りポーリングを続ける（execution.ts の run() と同様の
    // バックオフ規律: データがあれば即座に、無ければ段階的に待つ）。
    let idleAttempt = 0;
    while (page.nextUri) {
      currentNextUri = page.nextUri;
      if (signal?.aborted) break;
      const hadData = page.data !== undefined && page.data.length > 0;
      if (hadData) {
        idleAttempt = 0;
      } else {
        await client.waitBackoff(idleAttempt, signal);
        idleAttempt += 1;
      }
      if (signal?.aborted) break;
      page = await client.advance(page.nextUri, ctx, mutations, signal);
      writeHeader(page.columns);
      if (page.data) {
        for (const row of page.data) {
          chunk += csvRecord(row) + '\r\n';
          sinceFlush += 1;
        }
      }
      if (sinceFlush >= flushEvery) {
        yield chunk;
        chunk = '';
        sinceFlush = 0;
      }
    }
    // Reached here without a nextUri => the query finished; no teardown needed.
    // nextUri が無い状態でここに到達した場合はクエリが正常完了しているので、
    // 後始末（DELETE）は不要。
    if (!page.nextUri) currentNextUri = undefined;
    if (!signal?.aborted && chunk !== '') yield chunk;
  } finally {
    // If we left the loop early (client disconnect or an error) the query may
    // still be running server-side; DELETE its current nextUri to tear it down.
    // ループを早期に抜けた場合（クライアント切断やエラー）、Trino 側では
    // クエリがまだ動いている可能性があるため、直近の nextUri へ DELETE を
    // 送って後始末する。
    if (currentNextUri) {
      await client.cancel(currentNextUri, ctx).catch(() => {});
    }
  }
}

// 列情報が判明する（columns イベント）か、クエリが終端状態になるまで待つ。
// すでに条件を満たしていれば即座に解決する Promise を返す。
function waitForColumnsOrTerminal(exec: QueryExecution): Promise<void> {
  if (exec.columns.length > 0 || exec.isTerminal) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = exec.subscribe((event) => {
      if (event.type === 'columns' || event.type === 'done') {
        unsubscribe();
        resolve();
      }
    });
    // Guard against a race where it became terminal between the check and subscribe.
    // 最初のチェックと subscribe() の間に終端状態へ遷移してしまうレースを
    // 防ぐためのガード（イベントを取りこぼしても確実に解決させる）。
    if (exec.columns.length > 0 || exec.isTerminal) {
      unsubscribe();
      resolve();
    }
  });
}

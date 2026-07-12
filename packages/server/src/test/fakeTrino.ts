import { Hono } from 'hono';
import type { TrinoColumn, TrinoStats } from '../trino/types';

/**
 * A configurable in-process fake Trino `/v1/statement` server (Hono). Drives a
 * queued -> running -> finished `nextUri` progression with injectable data,
 * errors, cancellation, and `x-trino-set-*` headers.
 *
 * Build a scenario per statement (matched by substring) and obtain a `fetch`
 * impl that the TrinoClient can use.
 *
 * 日本語: このファイルは実際の Trino サーバーを起動せずにテストを走らせるための
 * 「偽の Trino」を提供する。Hono で `/v1/statement` プロトコル (POST で開始、
 * GET で nextUri を追走、DELETE でキャンセル) を模倣し、テストごとに用意した
 * `FakeScenario`（ステートメントの部分一致で選択される）に従って
 * QUEUED → RUNNING → FINISHED (または途中で FAILED) というページ progression を
 * 返す。TrinoClient の fetchImpl にこのインスタンスの `fetch` ゲッターを渡せば、
 * 実ネットワークなしに TrinoClient/runner/scheduler 等の挙動を検証できる。
 */

/** テスト用のカラム定義型。実体は TrinoColumn のエイリアス。 */
export type FakeColumn = TrinoColumn;

/** 1 回の `nextUri` GET に対して返す 1 ページ分のレスポンス内容。 */
export interface FakePage {
  /** Rows emitted on this page. */
  data?: unknown[][];
  /** Columns (usually set on the first data page). */
  columns?: FakeColumn[];
  /** Stats state override (else derived from page position). */
  state?: string;
  /** Set headers emitted with this page's response. */
  // 日本語: x-trino-set-catalog 等、TrinoClient の applySessionHeaders() が
  // 読み取るセッション変更系ヘッダーをこのページのレスポンスに追加したい場合に使う。
  setHeaders?: Record<string, string>;
}

/** 1 つのステートメント (部分一致) に対する一連の振る舞いを定義するシナリオ。 */
export interface FakeScenario {
  /** Substring matched against the statement to pick this scenario. */
  match: string;
  /** Optional structured error returned (immediately on the first nextUri). */
  // 日本語: 指定すると、最初の nextUri GET で即座に FAILED + この error を返す
  // (pages は無視される)。USER_ERROR を指定すれば retry.ts の deterministic 判定、
  // それ以外なら transient 判定のテストに使える。
  error?: {
    message: string;
    errorName?: string;
    errorCode?: number;
    /** e.g. `USER_ERROR` — used by Query Guard to classify the failure. */
    errorType?: string;
    errorLocation?: { lineNumber: number; columnNumber: number };
  };
  /** POST 受理後の最初の追走で返す、構造化 Trino error を持たない HTTP 障害。 */
  transportError?: {
    status: number;
    message: string;
  };
  /** Sequence of pages after the initial QUEUED POST response. */
  // 日本語: nextUri を追走するたびに順番に返されるページ列。最後のページで
  // nextUri を付けない (=FINISHED) ことで progression が終わる。
  pages?: FakePage[];
  /** Trino query id to report. */
  trinoId?: string;
}

// 日本語: 現在「実行中」として追跡しているクエリ 1 件分の内部状態。
// scenario は POST 時点で確定し、step は次に返すべきページ番号 (現状未使用の
// メタ情報として保持)、canceled は DELETE を受けたかどうかのフラグ。
interface RunningQuery {
  scenario: FakeScenario;
  step: number;
  canceled: boolean;
}

// 日本語: 発行したクエリ id をユニークにするためのグローバルなインクリメント
// カウンタ (FakeTrino インスタンスをまたいでも増え続ける)。
let counter = 0;

/**
 * 偽の Trino `/v1/statement` サーバー本体。
 *
 * 日本語: 内部で Hono アプリを 1 つ持ち (`buildApp()`)、`scenarios` に登録された
 * `FakeScenario` の中から、受け取ったステートメント文字列に `match` が
 * 部分文字列として含まれる最初のものを選んで progression を返す
 * (`pickScenario`)。実行中の各クエリは `running` Map で id ごとに追跡する。
 */
export class FakeTrino {
  private readonly scenarios: FakeScenario[] = [];
  private readonly running = new Map<string, RunningQuery>();
  readonly app: Hono;
  /** Records every request the client made, for assertions. */
  // 日本語: テストがヘッダー (X-Trino-User 等) やボディの内容をアサートできる
  // よう、受けたリクエストをすべて記録する。
  readonly requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  /**
   * When set, each `nextUri` GET awaits this promise before responding. Tests
   * use it to keep a query reliably "running" while they cancel it.
   */
  // 日本語: 「クエリが RUNNING のままキャンセルする」ようなタイミング依存の
  // テストで、advance の応答をわざと止めておくために使うフック。
  holdAdvance?: Promise<void>;

  constructor(scenarios: FakeScenario[] = []) {
    this.scenarios = scenarios;
    this.app = this.buildApp();
  }

  /**
   * Replace the scenario list at runtime (tests simulating a transient fault
   * that clears on retry: register a failing scenario, then swap it for a
   * succeeding one between attempts).
   */
  // 日本語: 例えば「1 回目は失敗するが、リトライすれば成功する」ケースを
  // テストする際、最初は失敗シナリオで開始し、リトライが発生するタイミングで
  // このメソッドを呼んで成功シナリオへ差し替える、という使い方をする。
  setScenarios(scenarios: FakeScenario[]): void {
    this.scenarios.length = 0;
    this.scenarios.push(...scenarios);
  }

  /** A `fetch` impl bound to this fake. Pass to `TrinoClient.fetchImpl`. */
  // 日本語: グローバル fetch と同じシグネチャで、実際には内部の Hono アプリへ
  // ルーティングするだけの薄いアダプタ。TrinoClientOptions.fetchImpl に渡す。
  get fetch(): typeof fetch {
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const req = new Request(input as never, init);
      return this.app.fetch(req);
    }) as typeof fetch;
  }

  /** Number of queries currently "running" (mid-progression). */
  get activeCount(): number {
    return this.running.size;
  }

  // 日本語: statement 文字列に scenario.match が部分文字列として含まれる
  // 最初のシナリオを返す (配列の先頭から探索)。見つからなければ undefined
  // (この場合 POST ハンドラは空の match のダミーシナリオを使う)。
  private pickScenario(statement: string): FakeScenario | undefined {
    return this.scenarios.find((s) => statement.includes(s.match));
  }

  // 日本語: /v1/statement の 3 エンドポイント (POST 開始、GET 追走、DELETE
  // キャンセル) を実装した Hono アプリを組み立てる。
  private buildApp(): Hono {
    const app = new Hono();
    const base = 'http://trino.test';

    // 日本語: 受けたリクエストの method/url/headers/(POST なら)body を
    // this.requests に記録する共通処理。POST のボディはここで読み取って
    // 返す (SQL ステートメント本文として後続処理でも使う)。
    const record = async (c: {
      req: {
        method: string;
        url: string;
        header: () => Record<string, string>;
        text: () => Promise<string>;
      };
    }) => {
      const headers = c.req.header();
      let body: string | undefined;
      if (c.req.method === 'POST') body = await c.req.text();
      this.requests.push({ method: c.req.method, url: c.req.url, headers, body });
      return body;
    };

    // Initial POST: respond QUEUED with a nextUri.
    // 日本語: ステートメント本文からシナリオを選び、新しい query id を発番して
    // running に登録する。実データはまだ返さず、常に QUEUED 状態 + 最初の
    // nextUri (.../1) を返して呼び出し側に advance() させる。
    app.post('/v1/statement', async (c) => {
      const statement = (await record(c as never)) ?? '';
      const scenario = this.pickScenario(statement);
      const id = `${scenario?.trinoId ?? 'query'}_${++counter}`;
      this.running.set(id, { scenario: scenario ?? { match: '' }, step: 0, canceled: false });
      return c.json({
        id,
        infoUri: `${base}/ui/query.html?${id}`,
        nextUri: `${base}/v1/statement/${id}/1`,
        stats: stats('QUEUED'),
      });
    });

    // nextUri GET: advance the progression.
    // 日本語: :n はこれが何回目の nextUri GET かを表す (1-based)。ここで
    // scenario.pages の該当インデックス (n-1) を返し、最後のページなら
    // nextUri を付けずに running から削除 (完了) する。
    app.get('/v1/statement/:id/:n', async (c) => {
      await record(c as never);
      // holdAdvance が設定されていれば、それが resolve するまで応答を遅延させる
      // (RUNNING 状態を維持したままキャンセルを試すテスト等で使う)。
      if (this.holdAdvance) await this.holdAdvance;
      const id = c.req.param('id');
      const n = Number.parseInt(c.req.param('n'), 10);
      const q = this.running.get(id);
      if (!q) {
        // 日本語: 既に完了/削除済みの id への問い合わせ。単純に FINISHED を返す。
        return c.json({ id, stats: stats('FINISHED') });
      }
      if (q.canceled) {
        // 日本語: DELETE によってキャンセル済みとマークされていれば、
        // Trino が実際に返す USER_CANCELED エラーを模して FAILED を返す。
        this.running.delete(id);
        return c.json(
          {
            id,
            stats: stats('FAILED'),
            error: { message: 'Query was canceled', errorName: 'USER_CANCELED' },
          },
          200,
        );
      }

      const scenario = q.scenario;
      // POST 受理後に応答経路だけが失敗する状況を再現する。
      // TrinoClient は構造化 error のない HTTP エラーを TrinoTransportError に変換する。
      if (scenario.transportError) {
        this.running.delete(id);
        return new Response(scenario.transportError.message, {
          status: scenario.transportError.status,
        });
      }
      // Error scenarios fail on first advance.
      // 日本語: エラーシナリオが指定されていれば、ページ内容に関わらず
      // 最初の advance で即座に FAILED + 指定エラーを返す。
      if (scenario.error) {
        this.running.delete(id);
        return c.json({ id, stats: stats('FAILED'), error: scenario.error });
      }

      const pages = scenario.pages ?? [];
      const idx = n - 1;
      if (idx < pages.length) {
        const page = pages[idx]!;
        const isLast = idx === pages.length - 1;
        // 日本語: page.state が明示されていればそれを使い、無ければ
        // 「最後のページなら FINISHED、それ以外は RUNNING」を既定値とする。
        const res: Record<string, unknown> = {
          id,
          stats: stats(page.state ?? (isLast ? 'FINISHED' : 'RUNNING')),
        };
        if (page.columns) res.columns = page.columns;
        if (page.data) res.data = page.data;
        // 日本語: 最後のページでなければ次の nextUri (n+1) を付与して
        // progression を継続させる。最後なら nextUri を付けず、running からも削除する。
        if (!isLast) res.nextUri = `${base}/v1/statement/${id}/${n + 1}`;
        else this.running.delete(id);
        if (page.setHeaders) {
          for (const [k, v] of Object.entries(page.setHeaders)) c.header(k, v);
        }
        return c.json(res);
      }
      // No more pages -> FINISHED, no nextUri.
      // 日本語: pages の範囲を超えて呼ばれた (通常は起こらないが安全策) 場合は
      // 無条件に FINISHED を返す。
      this.running.delete(id);
      return c.json({ id, stats: stats('FINISHED') });
    });

    // DELETE cancel.
    // 日本語: 対象クエリが running に存在すれば canceled フラグを立てるのみ
    // (実際の FAILED 化は次の advance GET で行う。Trino 実プロトコルの
    // 非同期キャンセルの挙動を模している)。
    app.delete('/v1/statement/:id/:n', async (c) => {
      await record(c as never);
      const id = c.req.param('id');
      const q = this.running.get(id);
      if (q) q.canceled = true;
      return c.body(null, 204);
    });

    return app;
  }
}

// 日本語: 指定した state 文字列に応じて、それらしい TrinoStats を組み立てる
// テスト用ヘルパー。実際の Trino が返す統計値の細かい正確性よりも、
// state 遷移 (QUEUED→RUNNING→FINISHED) をテストが観測できることを優先している。
function stats(state: string): TrinoStats {
  return {
    state,
    queuedSplits: state === 'QUEUED' ? 1 : 0,
    runningSplits: state === 'RUNNING' ? 2 : 0,
    completedSplits: state === 'FINISHED' ? 4 : 0,
    totalSplits: 4,
    processedRows: 0,
    processedBytes: 0,
    wallTimeMillis: 1,
    elapsedTimeMillis: 1,
    peakMemoryBytes: 0,
    progressPercentage: state === 'FINISHED' ? 100 : state === 'RUNNING' ? 50 : 0,
    nodes: 1,
  };
}

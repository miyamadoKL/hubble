import { Hono } from 'hono';
import type { TrinoColumn, TrinoStats } from '../trino/types';

/**
 * A configurable in-process fake Trino `/v1/statement` server (Hono). Drives a
 * queued -> running -> finished `nextUri` progression with injectable data,
 * errors, cancellation, and `x-trino-set-*` headers.
 *
 * Build a scenario per statement (matched by substring) and obtain a `fetch`
 * impl that the TrinoClient can use.
 */

export type FakeColumn = TrinoColumn;

export interface FakePage {
  /** Rows emitted on this page. */
  data?: unknown[][];
  /** Columns (usually set on the first data page). */
  columns?: FakeColumn[];
  /** Stats state override (else derived from page position). */
  state?: string;
  /** Set headers emitted with this page's response. */
  setHeaders?: Record<string, string>;
}

export interface FakeScenario {
  /** Substring matched against the statement to pick this scenario. */
  match: string;
  /** Optional structured error returned (immediately on the first nextUri). */
  error?: {
    message: string;
    errorName?: string;
    errorCode?: number;
    /** e.g. `USER_ERROR` — used by Query Guard to classify the failure. */
    errorType?: string;
    errorLocation?: { lineNumber: number; columnNumber: number };
  };
  /** Sequence of pages after the initial QUEUED POST response. */
  pages?: FakePage[];
  /** Trino query id to report. */
  trinoId?: string;
}

interface RunningQuery {
  scenario: FakeScenario;
  step: number;
  canceled: boolean;
}

let counter = 0;

export class FakeTrino {
  private readonly scenarios: FakeScenario[] = [];
  private readonly running = new Map<string, RunningQuery>();
  readonly app: Hono;
  /** Records every request the client made, for assertions. */
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
  setScenarios(scenarios: FakeScenario[]): void {
    this.scenarios.length = 0;
    this.scenarios.push(...scenarios);
  }

  /** A `fetch` impl bound to this fake. Pass to `TrinoClient.fetchImpl`. */
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

  private pickScenario(statement: string): FakeScenario | undefined {
    return this.scenarios.find((s) => statement.includes(s.match));
  }

  private buildApp(): Hono {
    const app = new Hono();
    const base = 'http://trino.test';

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
    app.get('/v1/statement/:id/:n', async (c) => {
      await record(c as never);
      if (this.holdAdvance) await this.holdAdvance;
      const id = c.req.param('id');
      const n = Number.parseInt(c.req.param('n'), 10);
      const q = this.running.get(id);
      if (!q) {
        return c.json({ id, stats: stats('FINISHED') });
      }
      if (q.canceled) {
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
      // Error scenarios fail on first advance.
      if (scenario.error) {
        this.running.delete(id);
        return c.json({ id, stats: stats('FAILED'), error: scenario.error });
      }

      const pages = scenario.pages ?? [];
      const idx = n - 1;
      if (idx < pages.length) {
        const page = pages[idx]!;
        const isLast = idx === pages.length - 1;
        const res: Record<string, unknown> = {
          id,
          stats: stats(page.state ?? (isLast ? 'FINISHED' : 'RUNNING')),
        };
        if (page.columns) res.columns = page.columns;
        if (page.data) res.data = page.data;
        if (!isLast) res.nextUri = `${base}/v1/statement/${id}/${n + 1}`;
        else this.running.delete(id);
        if (page.setHeaders) {
          for (const [k, v] of Object.entries(page.setHeaders)) c.header(k, v);
        }
        return c.json(res);
      }
      // No more pages -> FINISHED, no nextUri.
      this.running.delete(id);
      return c.json({ id, stats: stats('FINISHED') });
    });

    // DELETE cancel.
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

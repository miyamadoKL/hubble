import type { QueryEvent } from '@hue-fable/contracts';
import type { QueryExecution } from './execution';

/** Serialize a `QueryEvent` as an SSE frame (`event:` + `data:` + blank line). */
export function encodeSseEvent(event: QueryEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A keep-alive comment frame. */
export const SSE_KEEPALIVE = ': keep-alive\n\n';

const ROW_CHUNK_SIZE = 500;

/**
 * Produce the replay event sequence for a freshly-connected SSE client:
 * current state, columns, buffered rows (chunked), latest stats, and — if the
 * query is already terminal — a trailing error/done. Live events follow.
 */
export function buildReplayEvents(exec: QueryExecution): QueryEvent[] {
  const events: QueryEvent[] = [];
  events.push({ type: 'state', state: exec.state });
  if (exec.columns.length > 0) {
    events.push({ type: 'columns', columns: exec.columns });
  }
  const rows = exec.bufferedRows();
  for (let offset = 0; offset < rows.length; offset += ROW_CHUNK_SIZE) {
    events.push({ type: 'rows', offset, rows: rows.slice(offset, offset + ROW_CHUNK_SIZE) });
  }
  if (exec.stats) {
    events.push({ type: 'stats', stats: exec.stats });
  }
  if (exec.isTerminal) {
    if (exec.error) events.push({ type: 'error', error: exec.error });
    events.push({ type: 'done', state: exec.state, rowCount: exec.rowCount, truncated: exec.truncated });
  }
  return events;
}

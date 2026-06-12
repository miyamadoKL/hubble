// Presentation mode parsing (design.md §5 stretch: Presentation mode). A notebook
// is flattened into read-only "cards", split on `--` comment headings so a SQL
// cell like
//
//   -- Revenue by segment
//   SELECT ...;
//   -- Top customers
//   SELECT ...
//
// renders as two titled cards. Pure + testable; the component renders the result.

import type { Notebook } from '@hue-fable/contracts';

export interface PresentationCard {
  /** Heading text from the `--` comment that opened the card, or null. */
  title: string | null;
  /** The SQL/markdown body below the heading (trimmed; may be empty). */
  body: string;
  /** Source cell kind, so markdown cards can render differently. */
  kind: 'sql' | 'markdown';
}

/** A `--` line that is purely a comment heading (not trailing code). */
function headingOf(line: string): string | null {
  const m = /^\s*--+\s?(.*)$/.exec(line);
  if (!m) return null;
  const text = m[1]!.trim();
  return text.length > 0 ? text : null;
}

/** Split one SQL cell's source into heading-delimited cards. */
function splitSqlCell(source: string): PresentationCard[] {
  const lines = source.split('\n');
  const cards: PresentationCard[] = [];
  let title: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (title !== null || body.length > 0) cards.push({ title, body, kind: 'sql' });
    buf = [];
  };

  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== null) {
      // A heading starts a new card (flush the previous one first).
      flush();
      title = heading;
    } else {
      buf.push(line);
    }
  }
  flush();
  return cards;
}

/**
 * Flatten a notebook into presentation cards. SQL cells are split on `--`
 * headings; markdown cells become a single card with the cell's name as title.
 * Empty cards are dropped.
 */
export function toPresentationCards(notebook: Notebook): PresentationCard[] {
  const cards: PresentationCard[] = [];
  for (const cell of notebook.cells) {
    if (cell.kind === 'markdown') {
      const body = cell.source.trim();
      if (body.length > 0) cards.push({ title: cell.name ?? null, body, kind: 'markdown' });
      continue;
    }
    for (const card of splitSqlCell(cell.source)) {
      if (card.body.length > 0 || card.title) cards.push(card);
    }
  }
  return cards;
}

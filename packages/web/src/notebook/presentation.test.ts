import { describe, it, expect } from 'vitest';
import type { Notebook } from '@hue-fable/contracts';
import { toPresentationCards } from './presentation';

function nb(cells: Notebook['cells']): Notebook {
  return {
    id: 'nb',
    name: 'Demo',
    description: '',
    cells,
    variables: [],
    context: {},
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  };
}

describe('toPresentationCards', () => {
  it('splits a SQL cell on `--` headings into titled cards', () => {
    const cards = toPresentationCards(
      nb([
        {
          id: 'c1',
          kind: 'sql',
          source: '-- Revenue by segment\nSELECT 1;\n-- Top customers\nSELECT 2',
        },
      ]),
    );
    expect(cards).toEqual([
      { title: 'Revenue by segment', body: 'SELECT 1;', kind: 'sql' },
      { title: 'Top customers', body: 'SELECT 2', kind: 'sql' },
    ]);
  });

  it('keeps an untitled leading card when SQL precedes the first heading', () => {
    const cards = toPresentationCards(
      nb([{ id: 'c1', kind: 'sql', source: 'SELECT 0\n-- Header\nSELECT 1' }]),
    );
    expect(cards[0]).toEqual({ title: null, body: 'SELECT 0', kind: 'sql' });
    expect(cards[1]).toEqual({ title: 'Header', body: 'SELECT 1', kind: 'sql' });
  });

  it('renders markdown cells as a single card using the cell name as title', () => {
    const cards = toPresentationCards(
      nb([{ id: 'm1', kind: 'markdown', name: 'Intro', source: '# Hello' }]),
    );
    expect(cards).toEqual([{ title: 'Intro', body: '# Hello', kind: 'markdown' }]);
  });

  it('drops empty cells and whitespace-only sources', () => {
    const cards = toPresentationCards(
      nb([
        { id: 'a', kind: 'sql', source: '   \n  ' },
        { id: 'b', kind: 'markdown', source: '' },
      ]),
    );
    expect(cards).toEqual([]);
  });
});

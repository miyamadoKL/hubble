import { describe, it, expect } from 'vitest';
import type { QueryColumn } from '@hubble/contracts';
import { buildChartOption } from './chartOptions';
import type { ChartConfig } from './chartData';
import type { ChartTheme } from './chartTheme';

// Token names rather than hex literals — the no-raw-hex lint forbids hex in
// non-theme code, and these stand-ins are enough to assert on the option shape.
const theme: ChartTheme = {
  series: ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'],
  ink: '--ink',
  inkMuted: '--ink-muted',
  inkSubtle: '--ink-subtle',
  border: '--border',
  borderSubtle: '--border-subtle',
  surface: '--surface',
  surfaceRaised: '--surface-raised',
  accent: '--accent',
  fontFamily: 'Plex',
  fontMono: 'PlexMono',
};

const columns: QueryColumn[] = [
  { name: 'orderpriority', type: 'varchar(15)' },
  { name: 'c', type: 'bigint' },
  { name: 's', type: 'double' },
  { name: 'orderdate', type: 'date' },
];

const rows = [
  ['5-LOW', 3, 100.5, '1995-01-03'],
  ['1-URGENT', 1, 50.25, '1995-01-01'],
  ['3-MEDIUM', 2, 75.0, '1995-01-02'],
];

function seriesTypes(opt: Record<string, unknown>): string[] {
  return (opt.series as Array<{ type: string }>).map((s) => s.type);
}

describe('buildChartOption — bars', () => {
  const config: ChartConfig = { type: 'bars', xIndex: 0, yIndices: [1, 2], sort: 'none', limit: 'all' };
  const opt = buildChartOption({ columns, rows, config, theme })!;
  it('uses a category X axis with the row labels', () => {
    expect((opt.xAxis as { type: string }).type).toBe('category');
    expect((opt.xAxis as { data: string[] }).data).toEqual(['5-LOW', '1-URGENT', '3-MEDIUM']);
  });
  it('emits one bar series per Y measure', () => {
    expect(seriesTypes(opt)).toEqual(['bar', 'bar']);
    expect((opt.series as Array<{ name: string }>).map((s) => s.name)).toEqual(['c', 's']);
  });
  it('applies the token series palette', () => {
    expect(opt.color).toEqual(theme.series);
  });
});

describe('buildChartOption — lines', () => {
  const config: ChartConfig = { type: 'lines', xIndex: 0, yIndices: [1], sort: 'none', limit: 'all' };
  const opt = buildChartOption({ columns, rows, config, theme })!;
  it('emits line series', () => {
    expect(seriesTypes(opt)).toEqual(['line']);
  });
});

describe('buildChartOption — timeline', () => {
  const config: ChartConfig = { type: 'timeline', xIndex: 3, yIndices: [2], sort: 'none', limit: 'all' };
  const opt = buildChartOption({ columns, rows, config, theme })!;
  it('uses a time X axis', () => {
    expect((opt.xAxis as { type: string }).type).toBe('time');
  });
  it('sorts points by time ascending [timeMs, value]', () => {
    const data = (opt.series as Array<{ data: number[][] }>)[0]!.data;
    const times = data.map((d) => d[0]);
    expect(times).toEqual([...times].sort((a, b) => a! - b!));
    expect(times[0]).toBe(Date.parse('1995-01-01'));
  });
});

describe('buildChartOption — pie', () => {
  const config: ChartConfig = { type: 'pie', xIndex: 0, yIndices: [1], sort: 'desc', limit: 'all' };
  const opt = buildChartOption({ columns, rows, config, theme })!;
  it('emits a single pie series with {name,value} slices', () => {
    expect(seriesTypes(opt)).toEqual(['pie']);
    const data = (opt.series as Array<{ data: { name: string; value: number }[] }>)[0]!.data;
    // sort=desc on measure c → 3,2,1
    expect(data.map((d) => d.value)).toEqual([3, 2, 1]);
    expect(data[0]!.name).toBe('5-LOW');
  });
});

describe('buildChartOption — scatter', () => {
  it('plots numeric X vs Y and sizes points when a size column is set', () => {
    const config: ChartConfig = {
      type: 'scatter',
      xIndex: 1,
      yIndices: [2],
      sort: 'none',
      limit: 'all',
      sizeIndex: 2,
    };
    const opt = buildChartOption({ columns, rows, config, theme })!;
    expect(seriesTypes(opt)).toEqual(['scatter']);
    const data = (opt.series as Array<{ data: { value: number[]; symbolSize: number }[] }>)[0]!.data;
    expect(data[0]!.value).toEqual([3, 100.5]);
    // distinct sizes derived from the size column extent
    const sizes = new Set(data.map((d) => d.symbolSize));
    expect(sizes.size).toBeGreaterThan(1);
  });
  it('splits into one series per group when a grouping column is set', () => {
    const config: ChartConfig = {
      type: 'scatter',
      xIndex: 1,
      yIndices: [2],
      sort: 'none',
      limit: 'all',
      groupIndex: 0,
    };
    const opt = buildChartOption({ columns, rows, config, theme })!;
    expect((opt.series as unknown[]).length).toBe(3); // three distinct priorities
    expect(seriesTypes(opt)).toEqual(['scatter', 'scatter', 'scatter']);
  });
});

describe('buildChartOption — guards', () => {
  it('returns null when there is no X for a categorical chart', () => {
    const config: ChartConfig = { type: 'bars', xIndex: null, yIndices: [1], sort: 'none', limit: 'all' };
    expect(buildChartOption({ columns, rows, config, theme })).toBeNull();
  });
  it('returns null when there is no measure', () => {
    const config: ChartConfig = { type: 'bars', xIndex: 0, yIndices: [], sort: 'none', limit: 'all' };
    expect(buildChartOption({ columns, rows, config, theme })).toBeNull();
  });
});

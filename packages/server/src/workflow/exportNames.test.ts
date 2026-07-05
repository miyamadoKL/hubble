import { describe, expect, it } from 'vitest';
import {
  buildSheetNames,
  buildZipEntryNames,
  sanitizeSheetBase,
  sanitizeZipEntryBase,
} from './exportNames';

describe('workflow export names', () => {
  it('sanitizes zip entry base names', () => {
    expect(sanitizeZipEntryBase('Query/Result: v1')).toBe('Query_Result__v1');
    expect(sanitizeZipEntryBase('a'.repeat(120))).toHaveLength(100);
  });

  it('builds zip entry names with duplicate suffixes', () => {
    const names = buildZipEntryNames([{ name: 'report' }, { name: 'report' }]);
    expect(names).toEqual(['01_report.csv', '02_report.csv']);
    const forcedDup = buildZipEntryNames([{ name: 'same' }, { name: 'same' }]);
    expect(forcedDup[0]).toBe('01_same.csv');
    expect(forcedDup[1]).toBe('02_same.csv');
  });

  it('sanitizes sheet names and enforces Excel limits', () => {
    expect(sanitizeSheetBase("Sheet\\One?*[]:'")).toBe('Sheet_One_____');
    expect(sanitizeSheetBase('a'.repeat(40))).toHaveLength(31);
  });

  it('builds unique sheet names within 31 characters', () => {
    const long = 'Very Long Sheet Name That Exceeds Limit';
    const names = buildSheetNames([{ name: long }, { name: long }]);
    expect(names[0]).toHaveLength(31);
    expect(names[1]).toHaveLength(31);
    expect(names[0]).not.toBe(names[1]);
    expect(names[1]?.endsWith('~2')).toBe(true);
  });

  it('uses Step N when sheet name becomes empty', () => {
    expect(buildSheetNames([{ name: "''" }])).toEqual(['Step 1']);
  });
});

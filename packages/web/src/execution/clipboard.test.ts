// クリップボード出力の表計算ソフト向け無害化を検証する。
import type { QueryColumn } from '@hubble/contracts';
import { describe, expect, test } from 'vitest';
import { buildHtml, buildTsv } from './clipboard';

const columns: QueryColumn[] = [{ name: 'value', type: 'varchar' }];

describe('clipboard formula neutralization', () => {
  test.each([
    ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@command', "'@command"],
    ['\tcommand', "' command"],
    ['\rcommand', "' command"],
    ['\ncommand', "' command"],
  ])('TSVで危険な先頭文字を無害化する: %j', (input, expected) => {
    expect(buildTsv(columns, [[input]])).toBe(`value\n${expected}`);
  });

  test.each([
    ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@command', "'@command"],
    ['\tcommand', "'\tcommand"],
    ['\rcommand', "'\rcommand"],
    ['\ncommand', "'\ncommand"],
  ])('HTMLで危険な先頭文字を無害化する: %j', (input, expected) => {
    expect(buildHtml(columns, [[input]])).toContain(`<td>${expected}</td>`);
  });

  test('安全な文字列と数値の負数は変更しない', () => {
    expect(buildTsv(columns, [['safe'], [-1]])).toBe('value\nsafe\n-1');
    const html = buildHtml(columns, [['safe'], [-1]]);
    expect(html).toContain('<td>safe</td>');
    expect(html).toContain('<td>-1</td>');
  });

  test('オブジェクトと配列はJSON文字列化してから判定する', () => {
    const objectWithNegativeJson = { toJSON: () => -1 };

    expect(buildTsv(columns, [[objectWithNegativeJson], [['@command']]])).toBe(
      'value\n\'-1\n["@command"]',
    );
    const html = buildHtml(columns, [[objectWithNegativeJson], [['@command']]]);
    expect(html).toContain("<td>'-1</td>");
    expect(html).toContain('<td>["@command"]</td>');
  });

  test('列名にも同じ無害化を適用する', () => {
    const dangerousColumns: QueryColumn[] = [{ name: '=value', type: 'varchar' }];

    expect(buildTsv(dangerousColumns, [])).toBe("'=value");
    expect(buildHtml(dangerousColumns, [])).toContain("<th>'=value</th>");
  });
});

import { describe, expect, test } from 'vitest';
import type { Variable } from '@hubble/contracts';
import {
  detectVariables,
  inferType,
  reconcileVariables,
  substituteVariables,
  hasVariables,
} from './variables';

describe('detectVariables — the four Hue forms', () => {
  test('bare ${name}', () => {
    const [v] = detectVariables(['SELECT * FROM t WHERE id = ${id}']);
    expect(v).toMatchObject({ name: 'id', defaultValue: '', hasDefault: false });
    expect(v?.options).toBeUndefined();
  });

  test('${name=default}', () => {
    const [v] = detectVariables(['SELECT * FROM t LIMIT ${n=10}']);
    expect(v).toMatchObject({ name: 'n', defaultValue: '10', hasDefault: true });
    expect(v?.options).toBeUndefined();
  });

  test('${name=opt1,opt2} → plain select options', () => {
    const [v] = detectVariables(["WHERE status = '${status=O,F,P}'"]);
    expect(v?.name).toBe('status');
    expect(v?.defaultValue).toBe('O');
    expect(v?.options).toEqual([
      { label: 'O', value: 'O' },
      { label: 'F', value: 'F' },
      { label: 'P', value: 'P' },
    ]);
  });

  test('${name=label(value),…} → labelled select options', () => {
    const [v] = detectVariables(['WHERE seg = ${seg=Auto(AUTOMOBILE),Build(BUILDING)}']);
    expect(v?.name).toBe('seg');
    expect(v?.defaultValue).toBe('AUTOMOBILE');
    expect(v?.options).toEqual([
      { label: 'Auto', value: 'AUTOMOBILE' },
      { label: 'Build', value: 'BUILDING' },
    ]);
  });
});

describe('detectVariables — comment exclusion', () => {
  test('ignores ${…} inside a line comment', () => {
    expect(detectVariables(['SELECT 1 -- ${nope}\nFROM t'])).toEqual([]);
  });

  test('ignores ${…} inside a block comment', () => {
    expect(detectVariables(['SELECT 1 /* ${nope} and ${also} */ FROM t'])).toEqual([]);
  });

  test('DOES detect ${…} inside a string literal (Hue text templating)', () => {
    // `'${status=O,F,P}'` is the canonical Hue select-variable form; the quotes
    // belong to the resulting SQL, so the placeholder must be detected.
    const [v] = detectVariables(["WHERE s = '${status=O,F,P}'"]);
    expect(v?.name).toBe('status');
    expect(v?.options).toHaveLength(3);
  });

  test('detects real + string-literal vars, but not commented decoys', () => {
    const sql = "SELECT '${quoted}' -- ${commented}\nFROM t WHERE x = ${real} /* ${blocked} */";
    const names = detectVariables([sql]).map((v) => v.name);
    expect(names).toEqual(['quoted', 'real']);
  });
});

describe('detectVariables — dedup across cells', () => {
  test('first metadata-carrying form wins; order is first-seen', () => {
    const vars = detectVariables([
      'SELECT * FROM a WHERE x = ${x}',
      'SELECT * FROM b WHERE x = ${x=42} AND y = ${y=a,b}',
    ]);
    expect(vars.map((v) => v.name)).toEqual(['x', 'y']);
    const x = vars.find((v) => v.name === 'x');
    expect(x?.defaultValue).toBe('42');
    expect(x?.hasDefault).toBe(true);
  });

  test('rejects invalid names', () => {
    expect(detectVariables(['SELECT ${1bad}, ${ good }, ${}'])).toEqual([
      expect.objectContaining({ name: 'good' }),
    ]);
  });
});

describe('inferType — type inference', () => {
  test('options → select', () => {
    expect(
      inferType({
        name: 's',
        defaultValue: 'O',
        hasDefault: true,
        options: [{ label: 'O', value: 'O' }],
      }),
    ).toBe('select');
  });
  test('integer / decimal → number', () => {
    expect(inferType({ name: 'n', defaultValue: '10', hasDefault: true })).toBe('number');
    expect(inferType({ name: 'n', defaultValue: '-3.5', hasDefault: true })).toBe('number');
  });
  test('YYYY-MM-DD → date', () => {
    expect(inferType({ name: 'd', defaultValue: '2026-01-01', hasDefault: true })).toBe('date');
  });
  test('YYYY-MM-DDTHH:MM → datetime-local', () => {
    expect(inferType({ name: 'd', defaultValue: '2026-01-01T08:30', hasDefault: true })).toBe(
      'datetime-local',
    );
    expect(inferType({ name: 'd', defaultValue: '2026-01-01 08:30:00', hasDefault: true })).toBe(
      'datetime-local',
    );
  });
  test('true/false → checkbox', () => {
    expect(inferType({ name: 'b', defaultValue: 'true', hasDefault: true })).toBe('checkbox');
    expect(inferType({ name: 'b', defaultValue: 'FALSE', hasDefault: true })).toBe('checkbox');
  });
  test('no default / plain text → text', () => {
    expect(inferType({ name: 't', defaultValue: '', hasDefault: false })).toBe('text');
    expect(inferType({ name: 't', defaultValue: 'hello', hasDefault: true })).toBe('text');
  });
});

describe('reconcileVariables', () => {
  test('seeds new variables from defaults, preserves typed values, drops gone ones', () => {
    const detected = detectVariables(['WHERE a=${a=1} AND b=${b} AND c=${c=2026-01-01}']);
    const previous: Variable[] = [
      { name: 'b', value: 'typed', meta: { type: 'text' } },
      { name: 'old', value: 'x', meta: { type: 'text' } },
    ];
    const vars = reconcileVariables(detected, previous);
    expect(vars.map((v) => v.name)).toEqual(['a', 'b', 'c']); // 'old' dropped
    expect(vars.find((v) => v.name === 'a')?.value).toBe('1'); // seeded from default
    expect(vars.find((v) => v.name === 'b')?.value).toBe('typed'); // preserved
    expect(vars.find((v) => v.name === 'a')?.meta.type).toBe('number');
    expect(vars.find((v) => v.name === 'c')?.meta.type).toBe('date');
  });

  test('placeholder carries the default value for the input', () => {
    const detected = detectVariables(['LIMIT ${n=25}']);
    const [v] = reconcileVariables(detected, []);
    expect(v?.meta.placeholder).toBe('25');
  });
});

describe('substituteVariables', () => {
  test('uses supplied value over default', () => {
    const { text, missing } = substituteVariables('LIMIT ${n=10}', { n: '50' });
    expect(text).toBe('LIMIT 50');
    expect(missing).toEqual([]);
  });

  test('falls back to default when no value supplied', () => {
    const { text, missing } = substituteVariables('LIMIT ${n=10}', {});
    expect(text).toBe('LIMIT 10');
    expect(missing).toEqual([]);
  });

  test('reports missing when neither value nor default exists', () => {
    const { text, missing } = substituteVariables('WHERE id = ${id}', {});
    expect(text).toBe('WHERE id = ${id}');
    expect(missing).toEqual(['id']);
  });

  test('substitutes inside strings but never inside comments', () => {
    const sql = "SELECT '${x}' -- ${y}\nWHERE z = ${z=9}";
    const { text } = substituteVariables(sql, { x: 'IN', y: 'NOPE', z: '3' });
    // `${x}` inside the string is replaced; `${y}` in the comment is left as-is.
    expect(text).toBe("SELECT 'IN' -- ${y}\nWHERE z = 3");
  });

  test('empty supplied value falls back to default', () => {
    const { text } = substituteVariables('LIMIT ${n=10}', { n: '' });
    expect(text).toBe('LIMIT 10');
  });

  test('select option value substitutes', () => {
    const { text } = substituteVariables("status='${s=O,F,P}'", { s: 'F' });
    expect(text).toBe("status='F'");
  });
});

describe('hasVariables', () => {
  test('true with a real placeholder, false when only in a comment', () => {
    expect(hasVariables(['SELECT ${a}'])).toBe(true);
    expect(hasVariables(['SELECT 1 -- ${b}\nFROM t'])).toBe(false);
  });
});

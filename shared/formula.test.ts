import { describe, it, expect } from 'vitest';
import { parseFormula, evaluateFormula } from './formula.ts';
const run = (s: string) =>
  evaluateFormula(parseFormula(s), {
    getProperty: (n) => (n === 'Price' ? 5 : undefined),
    today: '2026-11-12',
    now: new Date('2026-11-12T12:00:00Z'),
  });
describe('formula language', () => {
  it('honors precedence and properties', () => {
    expect(run('prop("Price") * 2 + 1')).toBe(11);
    expect(run('not false and 2 >= 1')).toBe(true);
    expect(run('"a" + 2')).toBe('a2');
  });
  it('evaluates functions and lazy branches', () => {
    expect(run('if(true, round(2.345, 2), 1 / 0)')).toBe(2.35);
    expect(run('upper(concat("a", "b"))')).toBe('AB');
    expect(run('empty("")')).toBe(true);
  });
  it('handles dates and clamped months', () => {
    expect(run('dateAdd("2026-01-31", 1, "months")')).toBe('2026-02-28');
    expect(run('dateBetween(today(), "2026-11-10", "days")')).toBe(2);
    expect(run('formatDate(today())')).toBe('12 Nov 2026');
  });
  it('returns null for evaluation errors', () => {
    for (const s of ['1/0', 'prop("missing")', 'abs("x")', 'unknown()']) expect(run(s)).toBeNull();
  });
  it('rejects malformed and oversized input', () => {
    expect(parseFormula('1 +').ok).toBe(false);
    expect(parseFormula('x'.repeat(2001)).ok).toBe(false);
    expect(parseFormula(Array(102).fill('1').join('+')).ok).toBe(false);
  });
});
it('covers text, numeric and calendar functions', () => {
  const cases: Record<string, unknown> = {
    'length("abc")': 3,
    'contains("abc", "b")': true,
    'lower("AB")': 'ab',
    'floor(2.9)': 2,
    'ceil(2.1)': 3,
    'abs(-3)': 3,
    'min(4, 2, 9)': 2,
    'max(4, 2, 9)': 9,
    'toNumber("12")': 12,
    'format(true)': 'true',
    'year(today())': 2026,
    'month(today())': 11,
    'day(today())': 12,
    'weekday(today())': 4,
    'formatDate(today(), "iso")': '2026-11-12',
    'dateSubtract(today(), 1, "weeks")': '2026-11-05',
    'dateAdd("2024-02-29", 1, "years")': '2025-02-28',
    'dateBetween("2026-11-12T02:00:00Z", "2026-11-12T00:30:00Z", "minutes")': 90,
    '10 % 3': 1,
    '1 != 2 or false': true,
    'now()': '2026-11-12T12:00:00.000Z',
  };
  for (const [s, value] of Object.entries(cases)) expect(run(s), s).toBe(value);
});
it('reports positions and safely handles hostile expressions', () => {
  for (const s of ['globalThis.process.exit()', 'prop("x").constructor', '"unterminated', '(1 + 2', '1 2'])
    expect(parseFormula(s).ok, s).toBe(false);
  expect(run('dateAdd("bad", 1, "days")')).toBeNull();
  expect(run('toNumber("bad")')).toBeNull();
  expect(run('dateAdd(today(), 1, "seconds")')).toBeNull();
});
it('rejects invalid calendar dates and boolean operand types', () => {
  for (const s of [
    'year("2026-02-30")',
    'dateAdd("2026-13-01",1,"days")',
    'true and 1',
    'not "x"',
    'if(1,2,3)',
    'abs(1,2)',
    'now(1)',
  ])
    expect(run(s), s).toBeNull();
  expect(run('not 1 == 2')).toBe(true);
  expect(run('dateAdd("2026-11-12", 1, "hours")')).toBe('2026-11-12T01:00:00.000Z');
  expect(run('"2026-11-12T00:00:00+02:00" < "2026-11-11T23:00:00Z"')).toBe(true);
});
it('infers referenced computed dates and formula result types', () => {
  const schema: import('./types.ts').Property[] = [
    {
      id: 'r',
      name: 'Earliest',
      type: 'rollup',
      rollup: { source: { kind: 'relation', propertyId: 'rel' }, target: 'd', fn: 'earliest' },
    },
    { id: 'a', name: 'A', type: 'formula', formula: { expression: 'today()' } },
  ];
  const first = parseFormula('prop("Earliest")', schema),
    second = parseFormula('prop("A")', schema);
  expect(first.ok && first.resultType).toBe('date');
  expect(second.ok && second.resultType).toBe('date');
});

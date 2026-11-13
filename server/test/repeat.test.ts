import { expect, it } from 'vitest';
import { nextRepeatDate } from '../src/repeat.ts';
import type { Repeat } from '../../shared/types.ts';
const repeat: Repeat = {
  dateProp: 'date',
  every: 1,
  unit: 'month',
  from: 'due',
  until: null,
  doneProp: 'done',
  doneValue: true,
  resetValue: false,
};
it('clamps months and keeps ISO time', () => {
  expect(nextRepeatDate(repeat, '2026-01-31T14:20:00.000Z', '2026-01-31')).toBe('2026-02-28T14:20:00.000Z');
});
it('skips old due dates, respects completed mode and until', () => {
  expect(nextRepeatDate({ ...repeat, unit: 'day' }, '2026-01-01', '2026-01-04')).toBe('2026-01-05');
  expect(nextRepeatDate({ ...repeat, from: 'completed' }, '2026-01-01', '2026-03-15')).toBe('2026-04-15');
  expect(nextRepeatDate({ ...repeat, until: '2026-02-01' }, '2026-01-31', '2026-01-31')).toBeNull();
});
it('handles leap years and weekly selected weekdays', () => {
  expect(nextRepeatDate({ ...repeat, unit: 'year' }, '2024-02-29', '2024-02-29')).toBe('2025-02-28');
  expect(nextRepeatDate({ ...repeat, unit: 'week', weekdays: [1, 3] }, '2026-11-09', '2026-11-09')).toBe('2026-11-11');
  expect(nextRepeatDate({ ...repeat, unit: 'week', every: 2, weekdays: [1] }, '2026-11-09', '2026-11-09')).toBe(
    '2026-11-23',
  );
});
it('advances days and weeks and keeps the original timestamp suffix', () => {
  expect(nextRepeatDate({ ...repeat, unit: 'day', every: 3 }, '2026-11-01T09:30:00+02:00', '2026-11-10')).toBe(
    '2026-11-13T09:30:00+02:00',
  );
  expect(nextRepeatDate({ ...repeat, unit: 'week', every: 2 }, '2026-11-01', '2026-11-01')).toBe('2026-11-15');
});

import type { Repeat } from '../../shared/types.ts';
/** Calendar arithmetic uses UTC fields so server timezone cannot alter a date-only value. */
export function nextRepeatDate(repeat: Repeat, oldDate: string, today: string): string | null {
  const suffix = oldDate.slice(10);
  const base = repeat.from === 'completed' ? today : oldDate.slice(0, 10);
  let date = new Date(base + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime())) return null;
  const advance = () => {
    if (repeat.unit === 'week' && repeat.weekdays?.length) {
      const start = new Date(date);
      start.setUTCDate(start.getUTCDate() - start.getUTCDay());
      do {
        date.setUTCDate(date.getUTCDate() + 1);
      } while (
        !repeat.weekdays.includes(date.getUTCDay()) ||
        Math.floor((date.getTime() - start.getTime()) / 604800000) % repeat.every !== 0
      );
    } else if (repeat.unit === 'day' || repeat.unit === 'week')
      date.setUTCDate(date.getUTCDate() + repeat.every * (repeat.unit === 'week' ? 7 : 1));
    else {
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + repeat.every * (repeat.unit === 'year' ? 12 : 1));
      const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, end));
    }
  };
  do {
    advance();
  } while (repeat.from === 'due' && date.toISOString().slice(0, 10) <= today);
  const result = date.toISOString().slice(0, 10);
  return repeat.until && result > repeat.until ? null : result + suffix;
}
export function dateInZone(date: Date, timezone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { OptionColor, Property, Row, SelectOption } from '../../../shared/types.ts';
import { Popover } from '../ui.tsx';
import { cardProps, type Db } from './kit.tsx';
import './views.css';

// ---------- Day arithmetic shared with the timeline (whole days since 1970-01-01, UTC, no DST surprises) ----------
const DAY_MS = 86_400_000;

/** Day number of a 'YYYY-MM-DD' or ISO value (only its first 10 characters count); NaN when it isn't a date. */
export function dayNum(value: unknown): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof value === 'string' ? value : '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS : NaN;
}
export const dayKey = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const dayDate = (n: number) => new Date(n * DAY_MS);
export function todayNum() {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}
/** 0 = Monday … 6 = Sunday. */
export const weekday = (n: number) => (dayDate(n).getUTCDay() + 6) % 7;
/** A date value moved by whole days, keeping any time part after the date. */
export const shiftDate = (value: string, days: number) => dayKey(dayNum(value) + days) + value.slice(10);
export const fmtDay = (n: number, o: Intl.DateTimeFormatOptions) => dayDate(n).toLocaleDateString(undefined, { ...o, timeZone: 'UTC' });

/** The option that colours a row: its value in the first Status or Select property shown on cards. */
export function rowOption(db: Db, row: Row): { prop: Property; opt: SelectOption } | null {
  for (const prop of cardProps(db)) {
    if (prop.type !== 'status' && prop.type !== 'select') continue;
    const opt = prop.options?.find((o) => o.id === row.props[prop.id]);
    if (opt) return { prop, opt };
  }
  return null;
}

/** Hover text for a pill or bar, so the colour is never the only cue. */
export function rowLabel(db: Db, row: Row) {
  const o = rowOption(db, row);
  return `${row.title || 'Untitled'}${o ? ` · ${o.prop.name}: ${o.opt.name}` : ''}`;
}

/** Option colours for a pill or bar, as custom properties the stylesheet reads. */
export const tint = (c: OptionColor) => ({ '--tint-bg': `var(--o-${c}-bg)`, '--tint-fg': `var(--o-${c}-fg)` }) as CSSProperties;

const MAX_PILLS = 3;

export function CalendarView({ db }: { db: Db }) {
  const { view, schema, shown, canEdit } = db;
  const dateProp = schema.find((p) => p.id === view.dateProp && p.type === 'date');
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const dragId = useRef<string | null>(null);
  const [overDay, setOverDay] = useState<number | null>(null);

  if (!dateProp) {
    return <div className="empty"><CalendarDays size={22} />A calendar places rows on a date. Pick a date property from the view menu.</div>;
  }

  const byDay = new Map<number, Row[]>();
  const undated: Row[] = [];
  for (const r of shown) {
    const n = dayNum(r.props[dateProp.id]);
    if (isNaN(n)) undated.push(r);
    else byDay.set(n, [...(byDay.get(n) ?? []), r]);
  }

  const first = Date.UTC(month.y, month.m, 1) / DAY_MS;
  const next = Date.UTC(month.y, month.m + 1, 1) / DAY_MS;
  const start = first - weekday(first);
  const weeks = Math.ceil((next - start) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => start + i);
  const today = todayNum();
  const go = (delta: number) => setMonth(({ y, m }) => { const d = new Date(y, m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const goToday = () => { const d = new Date(); setMonth({ y: d.getFullYear(), m: d.getMonth() }); };

  const drop = (n: number) => {
    const id = dragId.current;
    dragId.current = null; setOverDay(null);
    const row = id ? shown.find((r) => r.id === id) : undefined;
    if (!row) return;
    const value = String(row.props[dateProp.id] ?? '');
    const from = dayNum(value);
    if (from !== n) db.patchRow(row.id, { props: { [dateProp.id]: isNaN(from) ? dayKey(n) : shiftDate(value, n - from) } });
  };

  const pill = (r: Row) => {
    const o = rowOption(db, r);
    return (
      <Link
        key={r.id} to={db.rowHref(r.id)} className="cal-pill" style={o ? tint(o.opt.color) : undefined} title={rowLabel(db, r)}
        draggable={canEdit}
        onDragStart={(e) => { dragId.current = r.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.title); }}
        onDragEnd={() => { dragId.current = null; setOverDay(null); }}
      >
        {r.icon && <span className="emoji" aria-hidden>{r.icon}</span>}<span className="cal-pill-t">{r.title || 'Untitled'}</span>
      </Link>
    );
  };

  return (
    <div className="cal">
      <div className="cal-head">
        <h2 className="cal-title" aria-live="polite">{fmtDay(first, { month: 'long', year: 'numeric' })}</h2>
        <span className="grow" />
        <button className="icon-btn" aria-label="Previous month" title="Previous month" onClick={() => go(-1)}><ChevronLeft size={17} /></button>
        <button className="btn small" onClick={goToday}>Today</button>
        <button className="icon-btn" aria-label="Next month" title="Next month" onClick={() => go(1)}><ChevronRight size={17} /></button>
      </div>

      <div className="cal-grid">
        {days.slice(0, 7).map((n) => <div key={`h${n}`} className="cal-dow" aria-hidden>{fmtDay(n, { weekday: 'short' })}</div>)}
        {days.map((n) => {
          const rows = byDay.get(n) ?? [];
          const extra = rows.length - MAX_PILLS;
          const label = fmtDay(n, { weekday: 'long', month: 'long', day: 'numeric' });
          const cls = ['cal-day', n < first || n >= next ? 'out' : '', n === today ? 'today' : '', weekday(n) > 4 ? 'weekend' : '', overDay === n ? 'over' : ''].filter(Boolean).join(' ');
          return (
            <div
              key={n} className={cls} role="group" aria-label={`${label}${rows.length ? `, ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` : ''}`}
              onDragOver={(e) => { if (!dragId.current) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overDay !== n) setOverDay(n); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverDay((d) => (d === n ? null : d)); }}
              onDrop={(e) => { e.preventDefault(); drop(n); }}
            >
              <div className="cal-day-head">
                <span className="cal-num" aria-current={n === today ? 'date' : undefined}>{dayDate(n).getUTCDate() === 1 ? fmtDay(n, { month: 'short', day: 'numeric' }) : dayDate(n).getUTCDate()}</span>
                {canEdit && (
                  <button className="icon-btn cal-add" aria-label={`New row on ${label}`} title="New row on this day" onClick={() => db.addRow({ [dateProp.id]: dayKey(n) })}>
                    <Plus size={14} />
                  </button>
                )}
              </div>
              <div className="cal-pills">
                {rows.slice(0, extra > 0 ? MAX_PILLS - 1 : MAX_PILLS).map(pill)}
                {extra > 0 && (
                  <Popover trigger={(p) => <button className="cal-more" {...p}>+{extra + 1} more</button>}>
                    <div className="menu-label">{label}</div>
                    <div className="cal-more-list">{rows.map(pill)}</div>
                  </Popover>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {undated.length > 0 && (
        <section className="cal-undated" aria-label="Rows without a date">
          <span className="cal-undated-h">No date ({undated.length})</span>
          {undated.map(pill)}
        </section>
      )}
    </div>
  );
}

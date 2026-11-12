import { GanttChart } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Row } from '../../../shared/types.ts';
import { PageIcon } from '../Shell.tsx';
import { dayDate, dayNum, fmtDay, rowLabel, rowOption, shiftDate, tint, todayNum, weekday } from './CalendarView.tsx';
import type { Db } from './kit.tsx';
import './views.css';

const PX_PER_DAY = { week: 44, month: 18, quarter: 7 } as const;
const NAME_W = 220;
const MIN_DAYS = 62;
const MIN_WIDTH = 1600;

type Span = { row: Row; start: number; end: number };

/** First day of the month that `n` falls in, `add` months later. */
function monthStart(n: number, add = 0) {
  const d = dayDate(n);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1) / 86_400_000;
}

/** The visible range: whole months around every bar and today, starting on a Monday so weekends line up. */
function rangeFor(spans: Span[], today: number, pxPerDay: number) {
  const lo = Math.min(today, ...spans.map((s) => s.start)) - 14;
  const hi = Math.max(today, ...spans.map((s) => s.end)) + 30;
  const from = monthStart(lo);
  const start = from - weekday(from);
  const days = Math.max(monthStart(hi, 1) - start, MIN_DAYS, Math.ceil(MIN_WIDTH / pxPerDay));
  return { start, days };
}

export function TimelineView({ db }: { db: Db }) {
  const { view, schema, shown, canEdit } = db;
  const zoom = view.zoom ?? 'month';
  const px = PX_PER_DAY[zoom];
  const startProp = schema.find((p) => p.id === view.dateProp && p.type === 'date');
  const endProp = schema.find((p) => p.id === view.endDateProp && p.type === 'date' && p.id !== startProp?.id);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; moved: boolean } | null>(null);
  const [shift, setShift] = useState<{ id: string; days: number } | null>(null);
  const today = todayNum();

  const spans: Span[] = [];
  const undated: Row[] = [];
  for (const row of shown) {
    const start = startProp ? dayNum(row.props[startProp.id]) : NaN;
    if (isNaN(start)) { undated.push(row); continue; }
    const end = endProp ? dayNum(row.props[endProp.id]) : NaN;
    spans.push({ row, start, end: isNaN(end) || end < start ? start : end });
  }
  const { start: rangeStart, days } = rangeFor(spans, today, px);
  const x = (n: number) => (n - rangeStart) * px;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - (el.clientWidth - NAME_W) / 3);
    // Scroll to today when the view opens or the zoom changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, !!startProp]);

  if (!startProp) {
    return <div className="empty"><GanttChart size={22} />A timeline draws rows as bars across time. Pick a date property from the view menu.</div>;
  }

  const move = (span: Span, by: number) => {
    if (!by) return;
    const props: Record<string, string> = { [startProp.id]: shiftDate(String(span.row.props[startProp.id]), by) };
    const endValue = endProp ? span.row.props[endProp.id] : null;
    if (endProp && typeof endValue === 'string' && !isNaN(dayNum(endValue))) props[endProp.id] = shiftDate(endValue, by);
    db.patchRow(span.row.id, { props });
  };

  const onPointerDown = (e: PointerEvent, id: string) => {
    if (!canEdit || e.button !== 0) return;
    drag.current = { id, x: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 3) d.moved = true;
    if (d.moved) setShift({ id: d.id, days: Math.round(dx / px) });
  };
  const onPointerUp = (span: Span) => {
    const d = drag.current;
    if (d?.moved && shift?.id === span.row.id) move(span, shift.days);
    setShift(null);
    // Leave `drag` set until the click that follows, so a drag doesn't also open the row.
    setTimeout(() => { drag.current = null; }, 0);
  };
  const onKeyDown = (e: KeyboardEvent, span: Span) => {
    if (!canEdit || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    move(span, e.key === 'ArrowLeft' ? -1 : 1);
  };

  const width = days * px;
  const months: { n: number; len: number }[] = [];
  for (let n = monthStart(rangeStart); n < rangeStart + days; n = monthStart(n, 1)) {
    const from = Math.max(n, rangeStart);
    months.push({ n: from, len: Math.min(monthStart(n, 1), rangeStart + days) - from });
  }
  const ticks = Array.from({ length: days }, (_, i) => rangeStart + i).filter((n) => zoom === 'week' || weekday(n) === 0);
  const hint = canEdit ? ' Drag, or press Alt+Left or Alt+Right, to move it.' : '';

  const bar = (span: Span) => {
    const { row } = span;
    const o = rowOption(db, row);
    const by = shift?.id === row.id ? shift.days : 0;
    const left = x(span.start + by);
    const w = (span.end - span.start + 1) * px;
    const title = row.title || 'Untitled';
    const inside = w >= title.length * 7.2 + 24;
    return (
      <Link
        to={db.rowHref(row.id)} draggable={false}
        className={`tl-bar${by ? ' moving' : ''}${canEdit ? ' movable' : ''}`}
        style={{ ...(o ? tint(o.opt.color) : {}), left, width: Math.max(w - 2, 6) }}
        title={`${rowLabel(db, row)} · ${fmtDay(span.start + by, { month: 'short', day: 'numeric' })}${span.end > span.start ? ` – ${fmtDay(span.end + by, { month: 'short', day: 'numeric' })}` : ''}.${hint}`}
        onPointerDown={(e) => onPointerDown(e, row.id)} onPointerMove={onPointerMove} onPointerUp={() => onPointerUp(span)}
        onPointerCancel={() => { drag.current = null; setShift(null); }}
        onClick={(e) => { if (drag.current?.moved) e.preventDefault(); }}
        onKeyDown={(e) => onKeyDown(e, span)}
      >
        <span className={inside ? 'tl-bar-t' : 'tl-bar-out'}>{title}</span>
      </Link>
    );
  };

  const nameCell = (row: Row) => (
    <Link to={db.rowHref(row.id)} className="tl-name">
      <PageIcon icon={row.icon} kind="page" /><span className="tl-name-t">{row.title || 'Untitled'}</span>
    </Link>
  );

  return (
    <div className="tl" ref={scroller} style={{ '--tl-day': `${px}px`, '--tl-name': `${NAME_W}px` } as CSSProperties}>
      <div className="tl-canvas" style={{ width: NAME_W + width }}>
        <div className="tl-head">
          <div className="tl-corner">{startProp.name}</div>
          <div className="tl-axis" style={{ width }}>
            <div className="tl-months">
              {months.map((m) => (
                <span key={m.n} className="tl-month" style={{ left: x(m.n), width: m.len * px }}>
                  <span className="tl-month-t">{fmtDay(m.n, { month: zoom === 'quarter' ? 'short' : 'long', year: 'numeric' })}</span>
                </span>
              ))}
            </div>
            <div className="tl-ticks" aria-hidden>
              {ticks.map((n) => (
                <span key={n} className={`tl-tick${n === today ? ' today' : ''}`} style={{ left: x(n), width: zoom === 'week' ? px : px * 7 }}>
                  {zoom === 'week' ? <>{fmtDay(n, { weekday: 'narrow' })} {dayDate(n).getUTCDate()}</> : dayDate(n).getUTCDate()}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className={`tl-body${zoom === 'quarter' ? '' : ' shade'}`}>
          {months.slice(1).map((m) => <span key={m.n} className="tl-month-line" style={{ left: NAME_W + x(m.n) }} aria-hidden />)}
          {today >= rangeStart && today < rangeStart + days && <span className="tl-today" style={{ left: NAME_W + x(today) + px / 2 }} aria-hidden />}
          {spans.map((span) => (
            <div key={span.row.id} className="tl-row">
              {nameCell(span.row)}
              <div className="tl-lane" style={{ width }}>{bar(span)}</div>
            </div>
          ))}
          {spans.length === 0 && <div className="tl-row tl-note"><span className="tl-name muted">No rows have a {startProp.name} yet.</span></div>}
          {undated.length > 0 && (
            <>
              <div className="tl-row tl-group"><span className="tl-name">No date ({undated.length})</span></div>
              {undated.map((row) => (
                <div key={row.id} className="tl-row">
                  {nameCell(row)}
                  <div className="tl-lane" style={{ width }} />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

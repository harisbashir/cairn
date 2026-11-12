import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../../../../shared/types.ts';
import { useShell } from '../../Shell.tsx';
import { useCalendarEvents } from '../hooks.ts';
import { num, type WidgetProps } from '../types.ts';
import { LoadError, SettingSelect, Settings, WidgetMessage } from './kit.tsx';

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Local calendar day an event starts on ('YYYY-MM-DD' strings are already local days). */
const startDay = (e: CalendarEvent) => (e.allDay || e.start.length === 10 ? e.start.slice(0, 10) : dayKey(new Date(e.start)));

function dayLabel(key: string, today: Date) {
  if (key === dayKey(today)) return 'Today';
  if (key === dayKey(addDays(today, 1))) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function CalendarWidget({ widget, editing, onChange }: WidgetProps) {
  const s = useShell();
  const days = num(widget.config.days, 14);
  const today = new Date();
  const from = dayKey(today);
  const events = useCalendarEvents(s.wid, from, dayKey(addDays(today, days)));

  const groups = new Map<string, CalendarEvent[]>();
  for (const e of events.data ?? []) {
    // Events that began earlier but are still running are listed under Today.
    const key = startDay(e) < from ? from : startDay(e);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  return (
    <>
      {editing && (
        <Settings>
          <SettingSelect
            label="Look ahead" value={String(days)}
            options={[7, 14, 30].map((n) => ({ value: String(n), label: `${n} days` }))}
            onChange={(v) => onChange({ ...widget.config, days: Number(v) })}
          />
        </Settings>
      )}
      {events.isError ? <LoadError what="Upcoming events" /> : events.data?.length === 0 ? (
        <WidgetMessage>Nothing coming up in the next {days} days. Dates in your databases and subscribed calendars show up here.</WidgetMessage>
      ) : events.data && (
        <div className="feed hm-cal">
          {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => (
            <section key={key} className="hm-cal-day" aria-label={dayLabel(key, today)}>
              <h3>{dayLabel(key, today)}</h3>
              {list.map((e) => {
                const body = (
                  <>
                    <span className="hm-dot" style={{ background: `var(--o-${e.color}-fg)` }} aria-hidden />
                    <span className="grow hm-ellipsis">
                      <b>{e.title || 'Untitled'}</b> <span className="muted">· {e.calendarName}</span>
                    </span>
                    <span className="when">
                      {e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </>
                );
                return e.pageId
                  ? <Link key={e.id} className="feed-row" to={`/w/${s.wid}/p/${e.pageId}`}>{body}</Link>
                  : <div key={e.id} className="feed-row" title={e.location || undefined}>{body}</div>;
              })}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

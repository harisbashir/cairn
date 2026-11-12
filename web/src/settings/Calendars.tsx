import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { CalendarFeed, ExternalCalendar, OptionColor } from '../../../shared/types.ts';
import { del, post, qc, timeAgo } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { useUi } from '../ui.tsx';
import { Code, LoadNote, Loading, useAct } from './common.tsx';
import { useCalendarFeed, useCalendars } from './hooks.ts';

const COLORS: { id: OptionColor; label: string }[] = [
  { id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }, { id: 'orange', label: 'Orange' }, { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' }, { id: 'red', label: 'Red' }, { id: 'teal', label: 'Teal' }, { id: 'yellow', label: 'Yellow' },
  { id: 'brown', label: 'Brown' }, { id: 'gray', label: 'Gray' },
];
const colorName = (c: OptionColor) => COLORS.find((x) => x.id === c)?.label ?? c;
const hostOf = (url: string) => { try { return new URL(url.replace(/^webcal:/i, 'https:')).host || url; } catch { return url; } };

export function CalendarsSection() {
  const s = useShell();
  return (
    <>
      <h2>Calendars</h2>
      <p className="muted">Dates in {s.workspace.name}’s databases can appear in your usual calendar app, and events from other calendars can appear in Cairn.</p>
      <FeedCard />
      <ExternalCalendars />
    </>
  );
}

function FeedCard() {
  const s = useShell();
  const ui = useUi();
  const act = useAct();
  const feed = useCalendarFeed(s.wid);
  const set = (f: CalendarFeed) => qc.setQueryData(['calendar-feed', s.wid], f);
  return (
    <>
      <h3>Subscribe from another calendar app</h3>
      <section>
        <p className="muted">Every database row with a date becomes an event. Your calendar app checks this private address for changes every few hours.</p>
        {feed.isPending && <Loading what="your calendar address" />}
        {feed.isError && <LoadNote what="your calendar address" error={feed.error} retry={() => feed.refetch()} />}
        {feed.data && !feed.data.url && (
          <div className="row"><button className="btn primary" onClick={() => act(async () => set(await post<CalendarFeed>(`/api/workspaces/${s.wid}/calendar-feed`)))}><Plus size={15} />Create Feed Address</button></div>
        )}
        {feed.data?.url && (
          <>
            <Code text={feed.data.url} label="Copy feed address" />
            <span className="subtle">Anyone with this address can see the dates you can see in this workspace. Keep it private.</span>
            <div className="row">
              <button className="btn" onClick={async () => {
                if (await ui.confirm({ title: 'Reset the feed address?', body: 'The current address stops working. Calendar apps subscribed to it need the new one.', action: 'Reset Address', danger: true })) {
                  act(async () => { await del(`/api/workspaces/${s.wid}/calendar-feed`); set(await post<CalendarFeed>(`/api/workspaces/${s.wid}/calendar-feed`)); }, 'New feed address created');
                }
              }}><RotateCcw size={15} />Reset Address</button>
            </div>
            <dl className="st-howto">
              <dt>Google Calendar</dt><dd>On a computer, next to <b>Other calendars</b> click <b>+</b> → <b>From URL</b>, paste the address and click <b>Add calendar</b>.</dd>
              <dt>Apple Calendar</dt><dd>On a Mac choose <b>File</b> → <b>New Calendar Subscription</b>. On iPhone go to Settings → Calendar → Accounts → Add Account → Other → <b>Add Subscribed Calendar</b>.</dd>
              <dt>Outlook</dt><dd>In Outlook on the web choose <b>Add calendar</b> → <b>Subscribe from web</b>, paste the address and click <b>Import</b>.</dd>
            </dl>
            <p className="subtle">Google and Outlook fetch the address from their own servers, so this Cairn server must be reachable from the internet at that address. Apple Calendar on a device in your network works without that.</p>
          </>
        )}
      </section>
    </>
  );
}

function ExternalCalendars() {
  const s = useShell();
  const ui = useUi();
  const act = useAct();
  const cals = useCalendars(s.wid);
  const canEdit = s.workspace.role !== 'viewer';
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState<OptionColor>('blue');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true); setError('');
    try {
      await post<ExternalCalendar>(`/api/workspaces/${s.wid}/calendars`, { name: name.trim(), url: url.trim(), color });
      setName(''); setUrl(''); await cals.refetch();
      ui.toast('Calendar added');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <h3>Show other calendars in Cairn</h3>
      <p className="muted st-help">Events from these calendars appear in “Coming up” in calendar views and in the calendar widget on Home. They’re shared with everyone in {s.workspace.name}.</p>
      {cals.isPending && <Loading what="calendars" />}
      {cals.isError && <LoadNote what="other calendars" error={cals.error} retry={() => cals.refetch()} />}
      {cals.data && cals.data.length > 0 && (
        <ul className="st-list">
          {cals.data.map((c) => (
            <li key={c.id} className="st-list-row">
              <span className={`st-dot st-dot-${c.color}`} aria-hidden />
              <span className="grow st-break">
                <b>{c.name}</b>
                <span className="subtle st-block">{colorName(c.color)} · {hostOf(c.url)}</span>
                {c.lastError
                  ? <span className="err st-block">Last update failed: {c.lastError}</span>
                  : <span className="subtle st-block">{c.lastSyncedAt ? `Updated ${timeAgo(c.lastSyncedAt)}` : 'Not updated yet'}</span>}
              </span>
              {canEdit && <button className="btn small danger" onClick={async () => {
                if (await ui.confirm({ title: `Remove “${c.name}”?`, body: 'Its events stop appearing in Cairn. The calendar itself isn’t changed.', action: 'Remove Calendar', danger: true })) {
                  act(async () => { await del(`/api/workspaces/${s.wid}/calendars/${c.id}`); await cals.refetch(); });
                }
              }}><Trash2 size={14} />Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {cals.data && cals.data.length === 0 && <p className="subtle">No other calendars yet.</p>}
      {cals.data && canEdit && (
        <section className="st-card">
          <b>Add a calendar</b>
          <label className="field"><span>Name</span><input className="input" placeholder="Family" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>ICS address</span>
            <input className="input" type="url" inputMode="url" spellCheck={false} placeholder="https://… .ics" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <ul className="st-hints subtle">
            <li><b>Google Calendar:</b> Settings → your calendar → “Secret address in iCal format”.</li>
            <li><b>Nextcloud:</b> Calendar → ••• next to the calendar → Copy private link, then add <code className="st-code">?export</code> to the end.</li>
            <li><b>Apple iCloud:</b> share the calendar as a Public Calendar and copy its link.</li>
          </ul>
          <fieldset className="field st-fieldset">
            <legend>Colour</legend>
            <div className="st-color-pick">
              {COLORS.map((c) => (
                <label key={c.id} className={`st-color-opt${color === c.id ? ' on' : ''}`}>
                  <input type="radio" name="st-cal-color" value={c.id} checked={color === c.id} onChange={() => setColor(c.id)} />
                  <span className={`st-dot st-dot-${c.id}`} aria-hidden />{c.label}
                </label>
              ))}
            </div>
          </fieldset>
          {error && <p className="err" role="alert">{error}</p>}
          <div className="row"><button className="btn primary" disabled={!name.trim() || !url.trim() || busy} onClick={add}><Plus size={15} />Add Calendar</button></div>
        </section>
      )}
    </>
  );
}

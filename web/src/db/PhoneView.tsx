import { ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Property, Row } from '../../../shared/types.ts';
import { MenuItem, Popover } from '../ui.tsx';
import { groupableProps, groupsFor, inGroup, newRowValue } from './groups.ts';
import { CardMeta, Chip, fmtDate, type Db } from './kit.tsx';

/**
 * The phone layout for wide views. Instead of a table or side-by-side columns:
 * one group at a time (picked from a scrolling strip), as large, tappable cards.
 * Calendars and timelines become an agenda grouped by day.
 */
export function PhoneView({ db }: { db: Db }) {
  const { view, schema } = db;
  const byDate = view.type === 'calendar' || view.type === 'timeline';
  const dateProp = byDate ? schema.find((p) => p.id === view.dateProp) ?? schema.find((p) => p.type === 'date') : undefined;
  if (dateProp) return <Agenda db={db} dateProp={dateProp} />;
  return <Grouped db={db} />;
}

function Card({ row, db, group }: { row: Row; db: Db; group?: Property }) {
  // Only single-choice options get the quick "Move to" sheet; other groupings change through the row's page.
  const pick = group && (group.type === 'select' || group.type === 'status') ? group : undefined;
  const current = pick ? pick.options?.find((o) => o.id === row.props[pick.id]) : undefined;
  return (
    <div className="pcard">
      <Link to={db.rowHref(row.id)} className="pcard-main">
        <span className="t">{row.icon && <span className="emoji ico">{row.icon}</span>}{row.title || 'Untitled'}</span>
        <CardMeta row={row} db={db} skip={group?.id} />
      </Link>
      {pick && db.canEdit ? (
        <Popover placement="bottom-end" trigger={(p) => (
          <button className="pcard-move" aria-label={`${pick.name}: ${current?.name ?? 'none'}. Change`} {...p}>
            {current ? <Chip opt={current} status={pick.type === 'status'} /> : <span className="chip">Set {pick.name}</span>}
          </button>
        )}>
          <div className="menu-label">Move to</div>
          {(pick.options ?? []).map((o) => (
            <MenuItem key={o.id} active={o.id === current?.id} onClick={() => db.patchRow(row.id, { props: { [pick.id]: o.id } })}><Chip opt={o} status={pick.type === 'status'} /></MenuItem>
          ))}
          {current && <MenuItem onClick={() => db.patchRow(row.id, { props: { [pick.id]: null } })}>No {pick.name}</MenuItem>}
        </Popover>
      ) : <ChevronRight size={18} color="var(--text-3)" aria-hidden />}
    </div>
  );
}

function Grouped({ db }: { db: Db }) {
  const { view, schema, shown } = db;
  const navigate = useNavigate();
  const groupable = groupableProps(schema);
  const group = groupable.find((p) => p.id === view.groupBy)
    ?? (view.type === 'board' ? undefined : schema.find((p) => p.type === 'status'));
  const visible = useMemo(() => (group ? groupsFor(group, shown, view, db) : []), [group, shown, view, db]);
  const counts = useMemo(() => new Map(visible.map((g) => [g.id, group ? shown.filter((r) => inGroup(r, group, g.id)).length : 0])), [visible, group, shown]);
  const tabs = visible.filter((g) => g.opt || (counts.get(g.id) ?? 0) > 0);
  const [tab, setTab] = useState<string>('all');
  const active = tab === 'all' || tabs.some((c) => c.id === tab) ? tab : 'all';
  const rows = !group || active === 'all' ? shown : shown.filter((r) => inGroup(r, group, active));
  const add = async () => {
    const row = await db.addRow(group && active !== 'all' ? { [group.id]: newRowValue(group, active) } : {});
    if (row) navigate(db.rowHref(row.id));
  };
  return (
    <div className="phone-view">
      {group && (
        <div className="seg-strip" role="tablist" aria-label={`Filter by ${group.name}`}>
          <button role="tab" aria-selected={active === 'all'} className={active === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All <b>{shown.length}</b></button>
          {tabs.map((c) => (
            <button key={c.id} role="tab" aria-selected={active === c.id} className={active === c.id ? 'on' : ''} onClick={() => setTab(c.id)}>
              {c.label} <b>{counts.get(c.id)}</b>
            </button>
          ))}
        </div>
      )}
      <div className="pcards">
        {rows.map((r) => <Card key={r.id} row={r} db={db} group={group} />)}
        {rows.length === 0 && <div className="empty">Nothing here{db.rows.length ? ' in this group' : ' yet'}.</div>}
      </div>
      {db.canEdit && <button className="btn large phone-add" onClick={add}><Plus size={17} />New</button>}
    </div>
  );
}

function dayLabel(key: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(`${key}T00:00:00`);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function Agenda({ db, dateProp }: { db: Db; dateProp: Property }) {
  const navigate = useNavigate();
  const todayKey = new Date().toLocaleDateString('en-CA');
  const [past, setPast] = useState(false);
  const { days, undated, earlier } = useMemo(() => {
    const map = new Map<string, Row[]>();
    const undated: Row[] = [];
    for (const r of db.shown) {
      const v = r.props[dateProp.id];
      if (!v) { undated.push(r); continue; }
      const key = String(v).slice(0, 10);
      (map.get(key) ?? map.set(key, []).get(key)!).push(r);
    }
    const all = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { days: all.filter(([k]) => k >= todayKey), earlier: all.filter(([k]) => k < todayKey), undated };
  }, [db.shown, dateProp.id, todayKey]);
  const section = (key: string, label: string, rows: Row[]) => (
    <section key={key}>
      <h3 className={`agenda-day${key === todayKey ? ' today' : ''}`}>{label}</h3>
      <div className="pcards">{rows.map((r) => <Card key={r.id} row={r} db={db} />)}</div>
    </section>
  );
  return (
    <div className="phone-view">
      {earlier.length > 0 && <button className="btn ghost small" onClick={() => setPast(!past)}>{past ? 'Hide' : 'Show'} earlier ({earlier.reduce((n, [, r]) => n + r.length, 0)})</button>}
      {past && earlier.map(([k, rows]) => section(k, fmtDate(k), rows))}
      {days.map(([k, rows]) => section(k, dayLabel(k), rows))}
      {days.length === 0 && <div className="empty">Nothing coming up.</div>}
      {undated.length > 0 && section('none', `No ${dateProp.name}`, undated)}
      {db.canEdit && <button className="btn large phone-add" onClick={async () => { const row = await db.addRow({ [dateProp.id]: todayKey }); if (row) navigate(db.rowHref(row.id)); }}><Plus size={17} />New</button>}
    </div>
  );
}

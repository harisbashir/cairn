import { Bell, BellPlus, Plus, Repeat as RepeatIcon, X } from 'lucide-react';
import { useState } from 'react';
import type { Page, Property, Reminder, Repeat } from '../../../shared/types.ts';
import { patch, qc, useWsUsers } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { Avatar, Modal, Popover, useUi } from '../ui.tsx';
import { todayKey } from './format.ts';
import './db3.css';

type User = { id: string; name: string; color: string };
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DONE_RE = /^(done|complete(d)?|finished|closed|shipped|resolved)$/i;

/** Saves repeat / reminders straight away and keeps the page and row caches in step. */
async function savePage(page: Page, body: Partial<Pick<Page, 'repeat' | 'reminders'>>, toast: (t: string) => void): Promise<boolean> {
  try {
    const saved = await patch<Page>(`/api/pages/${page.id}`, body);
    qc.setQueryData<Page>(['page', page.id], (old) => (old ? { ...old, repeat: saved.repeat, reminders: saved.reminders } : old));
    if (page.kind === 'row') qc.invalidateQueries({ queryKey: ['rows', page.parentId] });
    return true;
  } catch (err) { toast((err as Error).message); return false; }
}

// ---------- Repeat ----------
const unitWord = (u: Repeat['unit'], n: number) => `${u}${n === 1 ? '' : 's'}`;
export function repeatSummary(r: Repeat, schema: Property[]): string {
  const every = r.every === 1 ? `Every ${r.unit}` : `Every ${r.every} ${unitWord(r.unit, r.every)}`;
  const days = r.unit === 'week' && r.weekdays?.length ? ` on ${r.weekdays.map((d) => DAY_NAMES[d]).join(', ')}` : '';
  const from = r.from === 'completed' ? ' after done' : '';
  const until = r.until ? `, until ${new Date(`${r.until}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  const multi = schema.filter((p) => p.type === 'date').length > 1 ? ` (${schema.find((p) => p.id === r.dateProp)?.name ?? 'date'})` : '';
  return every + days + from + until + multi;
}

function doneDefaults(p: Property | undefined): { doneValue: string | boolean; resetValue: string | boolean | null } {
  if (!p) return { doneValue: true, resetValue: false };
  if (p.type === 'checkbox') return { doneValue: true, resetValue: false };
  const opts = p.options ?? [];
  const done = opts.find((o) => DONE_RE.test(o.name.trim())) ?? opts[opts.length - 1];
  return { doneValue: done?.id ?? '', resetValue: opts.find((o) => o.id !== done?.id)?.id ?? null };
}

function defaultRepeat(schema: Property[]): Repeat | null {
  const date = schema.find((p) => p.type === 'date');
  const done = schema.find((p) => p.type === 'status') ?? schema.find((p) => p.type === 'select') ?? schema.find((p) => p.type === 'checkbox');
  if (!date || !done) return null;
  return { dateProp: date.id, every: 1, unit: 'week', from: 'due', until: null, doneProp: done.id, ...doneDefaults(done) };
}

export function RepeatLine({ page, schema, canEdit }: { page: Page; schema: Property[]; canEdit: boolean }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const r = page.repeat;
  const dates = schema.filter((p) => p.type === 'date');
  const dones = schema.filter((p) => ['status', 'select', 'checkbox'].includes(p.type));
  if (!r && (!dates.length || !canEdit)) return null; // nothing to repeat
  const label = r ? repeatSummary(r, schema) : '';
  return (
    <div className="prop-line">
      <span className="prop-name"><RepeatIcon size={15} aria-hidden />Repeat</span>
      {canEdit ? (
        <>
          <button type="button" className={`cell d3-rcell${r ? '' : ' blank'}`} aria-label={r ? `Repeat: ${label}` : 'Set this row to repeat'} onClick={() => setOpen(true)}>
            {r ? label : <span className="subtle">Doesn’t repeat</span>}
          </button>
          {open && (
            <Modal onClose={() => setOpen(false)} label="Repeat" className="modal d3-modal d3-rmodal">
              {dones.length
                ? <RepeatPanel initial={r ?? defaultRepeat(schema)!} on={!!r} schema={schema} onCancel={() => setOpen(false)} onSave={async (next) => { if (await savePage(page, { repeat: next }, ui.toast)) setOpen(false); }} />
                : <div className="d3-rpanel"><h2>Repeat</h2><p className="muted">Add a Status, Select or Checkbox property to mark the row done. Repeating moves the date forward each time it’s done.</p><div className="d3-ractions"><span className="grow" /><button type="button" className="btn" onClick={() => setOpen(false)}>Close</button></div></div>}
            </Modal>
          )}
        </>
      ) : <div className="cell">{label}</div>}
    </div>
  );
}

function RepeatPanel({ initial, on, schema, onSave, onCancel }: { initial: Repeat; on: boolean; schema: Property[]; onSave: (r: Repeat | null) => void; onCancel: () => void }) {
  const [r, setR] = useState<Repeat>(initial);
  const set = (p: Partial<Repeat>) => setR((x) => ({ ...x, ...p }));
  const dates = schema.filter((p) => p.type === 'date');
  const dones = schema.filter((p) => ['status', 'select', 'checkbox'].includes(p.type));
  const doneProp = schema.find((p) => p.id === r.doneProp);
  const opts = doneProp?.options ?? [];
  const toggleDay = (d: number) => {
    const cur = r.weekdays ?? [];
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort();
    set({ weekdays: next.length ? next : undefined });
  };
  const valid = r.every >= 1 && r.every <= 365 && !!doneProp && (doneProp.type === 'checkbox' || !!r.doneValue);
  return (
    <div className="d3-rpanel">
      <h2>Repeat</h2>
      <div className="d3-rrow">
        <span className="d3-rlab">Every</span>
        <input className="input small d3-rnum" type="number" min={1} max={365} inputMode="numeric" aria-label="Repeat every" value={r.every}
          onChange={(e) => set({ every: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} />
        <select className="select small" aria-label="Unit" value={r.unit} onChange={(e) => set({ unit: e.target.value as Repeat['unit'], ...(e.target.value === 'week' ? {} : { weekdays: undefined }) })}>
          {(['day', 'week', 'month', 'year'] as const).map((u) => <option key={u} value={u}>{unitWord(u, r.every)}</option>)}
        </select>
      </div>
      {r.unit === 'week' && (
        <div className="d3-days" role="group" aria-label="On these days">
          {DAYS.map((d, i) => (
            <button key={i} type="button" className={`d3-day${r.weekdays?.includes(i) ? ' on' : ''}`} aria-pressed={!!r.weekdays?.includes(i)} aria-label={DAY_NAMES[i]} onClick={() => toggleDay(i)}>{d}</button>
          ))}
        </div>
      )}
      {dates.length > 1 && (
        <label className="d3-rrow"><span className="d3-rlab">Moves</span>
          <select className="select small grow" value={r.dateProp} onChange={(e) => set({ dateProp: e.target.value })}>{dates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </label>
      )}
      <label className="d3-rrow"><span className="d3-rlab">Count from</span>
        <select className="select small grow" value={r.from} onChange={(e) => set({ from: e.target.value as Repeat['from'] })}>
          <option value="due">The {schema.find((p) => p.id === r.dateProp)?.name ?? 'date'}</option>
          <option value="completed">The day it’s done</option>
        </select>
      </label>
      <label className="d3-rrow"><span className="d3-rlab">Until</span>
        <input className="input small grow" type="date" value={r.until ?? ''} min={todayKey()} onChange={(e) => set({ until: e.target.value || null })} aria-label="Stop repeating after" />
      </label>
      <div className="menu-sep" />
      <label className="d3-rrow"><span className="d3-rlab">Done when</span>
        <select className="select small grow" value={r.doneProp} onChange={(e) => { const p = schema.find((x) => x.id === e.target.value); set({ doneProp: e.target.value, ...doneDefaults(p) }); }}>
          {dones.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {doneProp && doneProp.type !== 'checkbox' && (
        <>
          <label className="d3-rrow"><span className="d3-rlab">is</span>
            <select className="select small grow" value={String(r.doneValue)} onChange={(e) => set({ doneValue: e.target.value })}>
              {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="d3-rrow"><span className="d3-rlab">Then reset to</span>
            <select className="select small grow" value={r.resetValue === null ? '' : String(r.resetValue)} onChange={(e) => set({ resetValue: e.target.value || null })}>
              <option value="">Empty</option>
              {opts.filter((o) => o.id !== r.doneValue).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        </>
      )}
      {doneProp?.type === 'checkbox' && <div className="subtle d3-rhint">When {doneProp.name} is checked, the date moves on and the box clears.</div>}
      {doneProp && doneProp.type !== 'checkbox' && <div className="subtle d3-rhint">When it’s marked done, the date moves to the next one and {doneProp.name} resets.</div>}
      <div className="d3-ractions">
        {on && <button type="button" className="btn" onClick={() => onSave(null)}>Stop Repeating</button>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={!valid} onClick={() => onSave(r)}>{on ? 'Save' : 'Repeat'}</button>
      </div>
    </div>
  );
}

// ---------- Reminders ----------
const OFFSETS: [number, string][] = [[0, 'At the time'], [15, '15 minutes before'], [60, '1 hour before'], [1440, '1 day before'], [2880, '2 days before'], [10080, '1 week before']];

function fmtAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function whenLabel(r: Reminder, schema: Property[]): string {
  if (!r.dateProp) return fmtAt(r.at);
  const name = schema.find((p) => p.id === r.dateProp)?.name ?? 'date';
  const off = OFFSETS.find(([m]) => m === r.offsetMinutes)?.[1];
  return r.offsetMinutes === 0 ? `On ${name}` : `${off ?? `${r.offsetMinutes} min before`} ${name}`;
}
function whoLabel(r: Reminder, schema: Property[], users: User[], me: string): string {
  const parts: string[] = [];
  if (r.personProp) parts.push(`people in ${schema.find((p) => p.id === r.personProp)?.name ?? 'a person property'}`);
  const ids = r.userIds.length ? r.userIds : r.personProp ? [] : [r.createdBy || me];
  for (const id of ids) parts.push(id === me ? 'you' : users.find((u) => u.id === id)?.name ?? 'someone');
  return parts.join(', ');
}

function ReminderChip({ r, schema, users, me, onDelete }: { r: Reminder; schema: Property[]; users: User[]; me: string; onDelete?: () => void }) {
  return (
    <span className="d3-rem">
      <Bell size={13} aria-hidden />
      <span className="d3-rem-t">{whenLabel(r, schema)}<span className="d3-rem-who"> · {whoLabel(r, schema, users, me)}</span></span>
      {onDelete && <button type="button" className="d3-rem-x" aria-label={`Delete reminder ${whenLabel(r, schema)}`} onClick={onDelete}><X size={13} /></button>}
    </span>
  );
}

function ReminderForm({ schema, users, me, absoluteOnly, onAdd, onCancel }: { schema: Property[]; users: User[]; me: string; absoluteOnly?: boolean; onCancel?: () => void; onAdd: (r: Omit<Reminder, 'id' | 'createdBy' | 'lastFiredFor'>) => void }) {
  const dates = absoluteOnly ? [] : schema.filter((p) => p.type === 'date');
  const persons = absoluteOnly ? [] : schema.filter((p) => p.type === 'person');
  const [rel, setRel] = useState<string>(dates[0]?.id ?? '');
  const [offset, setOffset] = useState(dates.length ? 1440 : 0);
  const tomorrow9 = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return toLocalInput(d); })();
  const [at, setAt] = useState(tomorrow9);
  const [who, setWho] = useState<string>('me'); // 'me' | 'prop:<id>' | 'pick'
  const [picked, setPicked] = useState<string[]>([me]);
  const ok = rel ? true : !!at && !isNaN(new Date(at).getTime());
  const add = () => onAdd({
    dateProp: rel || null, offsetMinutes: rel ? offset : 0, at: rel ? null : new Date(at).toISOString(),
    userIds: who === 'me' ? [me] : who === 'pick' ? picked : [], personProp: who.startsWith('prop:') ? who.slice(5) : null,
  });
  return (
    <div className="d3-remform">
      {!absoluteOnly && (
        <label className="d3-rrow"><span className="d3-rlab">When</span>
          <select className="select small grow" value={rel} onChange={(e) => setRel(e.target.value)}>
            {dates.map((p) => <option key={p.id} value={p.id}>Relative to {p.name}</option>)}
            <option value="">At a specific time</option>
          </select>
        </label>
      )}
      {rel ? (
        <label className="d3-rrow"><span className="d3-rlab" />
          <select className="select small grow" aria-label="How long before" value={offset} onChange={(e) => setOffset(Number(e.target.value))}>
            {OFFSETS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
          </select>
        </label>
      ) : (
        <label className="d3-rrow"><span className="d3-rlab">{absoluteOnly ? 'When' : ''}</span>
          <input className="input small grow" type="datetime-local" aria-label="Remind at" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
      )}
      <label className="d3-rrow"><span className="d3-rlab">Remind</span>
        <select className="select small grow" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="me">Me</option>
          {persons.map((p) => <option key={p.id} value={`prop:${p.id}`}>People in {p.name}</option>)}
          {users.length > 1 && <option value="pick">Choose people…</option>}
        </select>
      </label>
      {who === 'pick' && (
        <div className="d3-people" role="group" aria-label="People to remind">
          {users.map((u) => {
            const on = picked.includes(u.id);
            return (
              <button key={u.id} type="button" className={`d3-person${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== u.id) : [...picked, u.id])}>
                <Avatar name={u.name} color={u.color} />{u.id === me ? `${u.name} (you)` : u.name}
              </button>
            );
          })}
        </div>
      )}
      {rel && schema.find((p) => p.id === rel) && <div className="subtle d3-rhint">Dates without a time remind at your reminder hour (Settings).</div>}
      <div className="d3-ractions"><span className="grow" />{onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}<button type="button" className={`btn primary${onCancel ? '' : ' small'}`} disabled={!ok || (who === 'pick' && !picked.length)} onClick={add}><BellPlus size={14} />Add Reminder</button></div>
    </div>
  );
}

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "Remind" line on a row page. */
export function RemindLine({ page, schema, canEdit }: { page: Page; schema: Property[]; canEdit: boolean }) {
  const s = useShell();
  const ui = useUi();
  const users = useWsUsers(s.wid).data ?? [];
  const list = page.reminders ?? [];
  if (!canEdit && !list.length) return null;
  const setList = (next: Reminder[]) => savePage(page, { reminders: next }, ui.toast);
  return (
    <div className="prop-line">
      <span className="prop-name"><Bell size={15} aria-hidden />Remind</span>
      <div className="d3-remline">
        {list.map((r) => <ReminderChip key={r.id} r={r} schema={schema} users={users} me={s.user.id} onDelete={canEdit ? () => setList(list.filter((x) => x.id !== r.id)) : undefined} />)}
        {canEdit && list.length < 10 && (
          <Popover className="menu d3-wmenu" trigger={(p) => <button type="button" className={`d3-remadd${list.length ? ' small' : ''}`} {...p}>{list.length ? <><Plus size={13} />Add</> : <span className="subtle">Add a reminder</span>}</button>}>
            {(close) => (
              <div className="menu-pad d3-rpanel">
                <div className="d3-rhead"><BellPlus size={16} /><b>New Reminder</b></div>
                <ReminderForm schema={schema} users={users} me={s.user.id} onAdd={async (r) => { if (await setList([...list, r as Reminder])) close(); }} />
              </div>
            )}
          </Popover>
        )}
      </div>
    </div>
  );
}

/** Reminders on an ordinary page: a quiet line under the title, and the "Remind me…" dialog from the page menu. */
export function PageReminders({ page, canEdit, open, onClose }: { page: Page; canEdit: boolean; open: boolean; onClose: () => void }) {
  const s = useShell();
  const ui = useUi();
  const users = useWsUsers(s.wid).data ?? [];
  const list = page.reminders ?? [];
  const [show, setShow] = useState(false);
  const setList = (next: Reminder[]) => savePage(page, { reminders: next }, ui.toast);
  const visible = open || show;
  const close = () => { setShow(false); onClose(); };
  return (
    <>
      {list.length > 0 && (
        <div className="d3-pagerem">
          {list.map((r) => <ReminderChip key={r.id} r={r} schema={[]} users={users} me={s.user.id} onDelete={canEdit ? () => setList(list.filter((x) => x.id !== r.id)) : undefined} />)}
        </div>
      )}
      {visible && (
        <Modal onClose={close} label="Remind me" className="modal d3-modal">
          <h2>Remind Me</h2>
          {list.length > 0 && <div className="d3-remline">{list.map((r) => <ReminderChip key={r.id} r={r} schema={[]} users={users} me={s.user.id} onDelete={() => setList(list.filter((x) => x.id !== r.id))} />)}</div>}
          <p className="muted d3-lede">Get a notification about “{page.title || 'Untitled'}” at a time you choose.</p>
          <ReminderForm schema={[]} users={users} me={s.user.id} absoluteOnly onCancel={close} onAdd={async (r) => { if (await setList([...list, r as Reminder])) { ui.toast('Reminder set'); close(); } }} />
        </Modal>
      )}
    </>
  );
}

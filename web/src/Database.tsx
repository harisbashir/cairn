import {
  ArrowDownUp, ArrowUpRight, Calendar, Check, CheckSquare, ChevronDown, CircleDot, EyeOff, Filter as FilterIcon, Hash, Kanban, Link2,
  List as ListIcon, ListFilter, Plus, SlidersHorizontal, Table2, Tags, Trash2, Type, User as UserIcon, X, ArrowLeftRight,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { applyView } from '../../shared/query.ts';
import type {
  Filter, FilterOp, OptionColor, Page, Property, PropertyType, Props, PropValue, Row, SelectOption, Sort, View, ViewType,
} from '../../shared/types.ts';
import { patch, post, qc, uid, useRows, useWsUsers } from './api.ts';
import { PageIcon, useShell } from './Shell.tsx';
import { Avatar, MenuItem, Popover, useUi } from './ui.tsx';

type WsUser = { id: string; name: string; color: string };
const COLORS: OptionColor[] = ['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'red'];
const TYPES: { type: PropertyType; label: string }[] = [
  { type: 'text', label: 'Text' }, { type: 'number', label: 'Number' }, { type: 'select', label: 'Select' },
  { type: 'multi_select', label: 'Multi-select' }, { type: 'status', label: 'Status' }, { type: 'date', label: 'Date' },
  { type: 'checkbox', label: 'Checkbox' }, { type: 'url', label: 'Link' }, { type: 'person', label: 'Person' }, { type: 'relation', label: 'Relation' },
];
const hasOptions = (t: PropertyType) => t === 'select' || t === 'multi_select' || t === 'status';
const isMulti = (t: PropertyType) => t === 'multi_select' || t === 'person' || t === 'relation';

export function PropIcon({ type, size = 15 }: { type: PropertyType | 'title'; size?: number }) {
  const I = { title: Type, text: Type, number: Hash, select: ChevronDown, multi_select: Tags, status: CircleDot, date: Calendar, checkbox: CheckSquare, url: Link2, person: UserIcon, relation: ArrowLeftRight }[type];
  return <I size={size} aria-hidden style={{ flex: 'none' }} />;
}

function Chip({ opt, status }: { opt: SelectOption; status?: boolean }) {
  return <span className={`chip ${opt.color}${status ? ' status' : ''}`}>{opt.name}</span>;
}

function fmtDate(v: string) {
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  return isNaN(d.getTime()) ? v : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Read-only rendering of a value (cards, lists, public pages). */
export function PropValueView({ prop, value, users, relTitles }: { prop: Property; value: PropValue; users: WsUser[]; relTitles?: Map<string, string> }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return null;
  const opt = (id: string) => prop.options?.find((o) => o.id === id);
  switch (prop.type) {
    case 'select': case 'status': { const o = opt(String(value)); return o ? <Chip opt={o} status={prop.type === 'status'} /> : null; }
    case 'multi_select': return <>{(value as string[]).map((id) => { const o = opt(id); return o ? <Chip key={id} opt={o} /> : null; })}</>;
    case 'checkbox': return value ? <span className="row" style={{ gap: 4 }}><Check size={14} />{prop.name}</span> : null;
    case 'date': return <span>{fmtDate(String(value))}</span>;
    case 'url': return <a href={String(value)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{String(value).replace(/^https?:\/\//, '')}</a>;
    case 'person': return <>{(value as string[]).map((id) => { const u = users.find((x) => x.id === id); return u ? <span key={id} className="row" style={{ gap: 4 }}><Avatar name={u.name} color={u.color} />{u.name}</span> : null; })}</>;
    case 'relation': return <>{(value as string[]).map((id) => <span key={id} className="chip">{relTitles?.get(id) ?? 'Linked row'}</span>)}</>;
    default: return <span>{String(value)}</span>;
  }
}

/** Editable value, used in table cells and on a row's own page. */
export function PropValueEditor({ prop, value, editable, users, wid, onChange, onAddOption }: {
  prop: Property; value: PropValue; editable: boolean; users: WsUser[]; wid: string;
  onChange: (v: PropValue) => void; onAddOption?: (name: string) => SelectOption;
}) {
  const rel = useRows(prop.type === 'relation' ? prop.relationDatabaseId : undefined);
  const relTitles = useMemo(() => new Map((rel.data ?? []).map((r) => [r.id, r.title || 'Untitled'])), [rel.data]);
  if (!editable) return <div className="cell"><PropValueView prop={prop} value={value} users={users} relTitles={relTitles} /></div>;

  if (prop.type === 'text' || prop.type === 'url' || prop.type === 'number') {
    return (
      <input
        key={String(value ?? '')} className="cell-input" defaultValue={value === null || value === undefined ? '' : String(value)} aria-label={prop.name}
        type={prop.type === 'number' ? 'number' : 'text'} inputMode={prop.type === 'number' ? 'decimal' : undefined} placeholder={prop.type === 'url' ? 'https://' : ''}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = String(value ?? ''); e.currentTarget.blur(); } }}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const next: PropValue = raw === '' ? null : prop.type === 'number' ? Number(raw) : raw;
          if (next !== (value ?? null) && !(typeof next === 'number' && isNaN(next))) onChange(next);
        }}
      />
    );
  }
  if (prop.type === 'checkbox') {
    return <label className="cell"><input type="checkbox" checked={!!value} aria-label={prop.name} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} /></label>;
  }
  if (prop.type === 'date') {
    return <input className="cell-input" type="date" aria-label={prop.name} value={value ? String(value).slice(0, 10) : ''} onChange={(e) => onChange(e.target.value || null)} />;
  }

  const multi = isMulti(prop.type);
  const selected: string[] = multi ? ((value as string[] | null) ?? []) : value ? [String(value)] : [];
  const choices: { id: string; node: ReactNode; name: string }[] =
    prop.type === 'person' ? users.map((u) => ({ id: u.id, name: u.name, node: <span className="row" style={{ gap: 6 }}><Avatar name={u.name} color={u.color} />{u.name}</span> }))
    : prop.type === 'relation' ? (rel.data ?? []).map((r) => ({ id: r.id, name: r.title || 'Untitled', node: <span>{r.icon} {r.title || 'Untitled'}</span> }))
    : (prop.options ?? []).map((o) => ({ id: o.id, name: o.name, node: <Chip opt={o} status={prop.type === 'status'} /> }));
  const pick = (id: string, close: () => void) => {
    if (multi) onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else { onChange(selected[0] === id ? null : id); close(); }
  };
  return (
    <Popover trigger={(p) => (
      <button type="button" className="cell" aria-label={prop.name} {...p}>
        <PropValueView prop={prop} value={value} users={users} relTitles={relTitles} />
      </button>
    )}>
      {(close) => <ChoiceList choices={choices} selected={selected} onPick={(id) => pick(id, close)}
        emptyText={prop.type === 'relation' ? (prop.relationDatabaseId ? 'No rows in the linked database yet.' : 'Choose a database for this relation in the column menu.') : 'No options yet.'}
        onCreate={hasOptions(prop.type) && onAddOption ? (name) => { const o = onAddOption(name); pick(o.id, close); } : undefined} />}
    </Popover>
  );
}

function ChoiceList({ choices, selected, onPick, onCreate, emptyText }: {
  choices: { id: string; node: ReactNode; name: string }[]; selected: string[]; onPick: (id: string) => void; onCreate?: (name: string) => void; emptyText: string;
}) {
  const [q, setQ] = useState('');
  const shown = choices.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const exact = choices.some((c) => c.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <div style={{ width: 250 }}>
      {(choices.length > 6 || onCreate) && (
        <div style={{ padding: '3px 3px 6px' }}>
          <input className="input small" autoFocus placeholder={onCreate ? 'Search or create…' : 'Search…'} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (shown.length === 1) onPick(shown[0].id); else if (onCreate && q.trim() && !exact) { onCreate(q.trim()); setQ(''); } } }} />
        </div>
      )}
      {shown.map((c) => (
        <button key={c.id} type="button" className="menu-item" onClick={() => onPick(c.id)}>
          <span className="grow">{c.node}</span>{selected.includes(c.id) && <Check size={15} />}
        </button>
      ))}
      {onCreate && q.trim() && !exact && <button type="button" className="menu-item" onClick={() => { onCreate(q.trim()); setQ(''); }}><Plus size={15} /><span className="grow">Create “{q.trim()}”</span></button>}
      {!shown.length && !(onCreate && q.trim()) && <div className="menu-label" style={{ fontWeight: 400 }}>{emptyText}</div>}
    </div>
  );
}

// ---------- Database view ----------
interface Db {
  page: Page; schema: Property[]; view: View; rows: Row[]; shown: Row[]; canEdit: boolean; users: WsUser[]; wid: string;
  setSchema: (s: Property[]) => void; setView: (patch: Partial<View>) => void;
  patchRow: (id: string, body: { title?: string; props?: Props }) => void; addRow: (props?: Props) => void; addOption: (propId: string, name: string) => SelectOption;
}

export function DatabaseView({ page, canEdit, save }: { page: Page; canEdit: boolean; save: (p: { schema?: Property[]; views?: View[] }, now?: boolean) => void }) {
  const s = useShell();
  const ui = useUi();
  const rowsQ = useRows(page.id);
  const users = useWsUsers(s.wid).data ?? [];
  const [schema, setSchemaState] = useState(page.schema);
  const [views, setViewsState] = useState<View[]>(page.views.length ? page.views : [{ id: 'default', name: 'Table', type: 'table', filters: [], sorts: [] }]);
  const stamp = useRef(page.updatedAt);
  const editing = useRef(0);
  useEffect(() => { // adopt remote schema/view changes when we haven't just edited
    if (page.updatedAt === stamp.current || Date.now() - editing.current < 2500) return;
    stamp.current = page.updatedAt; setSchemaState(page.schema); if (page.views.length) setViewsState(page.views);
  }, [page.updatedAt, page.schema, page.views]);
  const [viewId, setViewId] = useState(() => localStorage.getItem(`cairn.view.${page.id}`) ?? '');
  const view = views.find((v) => v.id === viewId) ?? views[0];
  const rows = rowsQ.data ?? [];
  const shown = useMemo(() => applyView(rows, view, schema), [rows, view, schema]);

  const setSchema = (next: Property[]) => { editing.current = Date.now(); setSchemaState(next); save({ schema: next }, true); };
  const setViews = (next: View[]) => { editing.current = Date.now(); setViewsState(next); save({ views: next }, true); };
  const setView = (p: Partial<View>) => setViews(views.map((v) => (v.id === view.id ? { ...v, ...p } : v)));
  const pickView = (id: string) => { setViewId(id); localStorage.setItem(`cairn.view.${page.id}`, id); };

  const patchRow: Db['patchRow'] = (id, body) => {
    qc.setQueryData<Row[]>(['rows', page.id], (old) => old?.map((r) => (r.id === id ? { ...r, ...(body.title !== undefined ? { title: body.title } : {}), props: { ...r.props, ...body.props } } : r)));
    patch(`/api/pages/${id}`, body).then(() => qc.invalidateQueries({ queryKey: ['page', id] })).catch((err) => { ui.toast((err as Error).message); rowsQ.refetch(); });
  };
  const addRow: Db['addRow'] = async (props = {}) => {
    // New rows start out matching simple "is" filters so they don't vanish from the view.
    const preset: Props = {};
    for (const f of view.filters) if (f.op === 'eq' && f.propertyId !== 'title' && f.value !== undefined) preset[f.propertyId] = f.value;
    try {
      const row = await post<Page>(`/api/workspaces/${s.wid}/pages`, { kind: 'row', parentId: page.id, title: '', props: { ...preset, ...props } });
      await rowsQ.refetch();
      setTimeout(() => (document.querySelector(`[data-row="${row.id}"] input`) as HTMLInputElement | null)?.focus(), 30);
    } catch (err) { ui.toast((err as Error).message); }
  };
  const addOption: Db['addOption'] = (propId, name) => {
    const prop = schema.find((p) => p.id === propId)!;
    const opt: SelectOption = { id: uid(), name, color: COLORS[(prop.options?.length ?? 0) % COLORS.length] };
    setSchema(schema.map((p) => (p.id === propId ? { ...p, options: [...(p.options ?? []), opt] } : p)));
    return opt;
  };
  const addViewOf = (type: ViewType) => {
    const groupBy = type === 'board' ? schema.find((p) => p.type === 'status' || p.type === 'select')?.id : undefined;
    const v: View = { id: uid(), name: { table: 'Table', board: 'Board', list: 'List' }[type], type, filters: [], sorts: [], groupBy };
    setViews([...views, v]); pickView(v.id);
  };

  const db: Db = { page, schema, view, rows, shown, canEdit, users, wid: s.wid, setSchema, setView, patchRow, addRow, addOption };
  const VIcon = { table: Table2, board: Kanban, list: ListIcon };

  return (
    <div>
      <div className="db-bar">
        {views.map((v) => {
          const I = VIcon[v.type];
          return v.id === view.id && canEdit ? (
            <Popover key={v.id} trigger={(p) => <button className="view-tab active" {...p}><I size={15} />{v.name}<ChevronDown size={13} /></button>}>
              <div className="menu-pad"><input className="input small" aria-label="View name" defaultValue={v.name} onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== v.name) setView({ name: n }); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></div>
              <div className="menu-label">Layout</div>
              {(['table', 'board', 'list'] as ViewType[]).map((t) => { const TI = VIcon[t]; return (
                <MenuItem key={t} icon={<TI size={16} />} active={v.type === t} onClick={() => setView({ type: t, groupBy: t === 'board' ? (v.groupBy ?? schema.find((p) => p.type === 'status' || p.type === 'select')?.id) : v.groupBy })}>{{ table: 'Table', board: 'Board', list: 'List' }[t]}</MenuItem>
              ); })}
              {v.type === 'board' && (<>
                <div className="menu-label">Group by</div>
                {schema.filter((p) => p.type === 'select' || p.type === 'status').map((p) => <MenuItem key={p.id} icon={<PropIcon type={p.type} />} active={v.groupBy === p.id} onClick={() => setView({ groupBy: p.id })}>{p.name}</MenuItem>)}
              </>)}
              {views.length > 1 && (<><div className="menu-sep" /><MenuItem danger icon={<Trash2 size={16} />} onClick={() => { setViews(views.filter((x) => x.id !== v.id)); pickView(''); }}>Delete View</MenuItem></>)}
            </Popover>
          ) : <button key={v.id} className={`view-tab${v.id === view.id ? ' active' : ''}`} onClick={() => pickView(v.id)}><I size={15} />{v.name}</button>;
        })}
        {canEdit && (
          <Popover trigger={(p) => <button className="icon-btn" aria-label="Add a view" title="Add a view" {...p}><Plus size={16} /></button>}>
            <div className="menu-label">New view</div>
            <MenuItem icon={<Table2 size={16} />} onClick={() => addViewOf('table')}>Table</MenuItem>
            <MenuItem icon={<Kanban size={16} />} onClick={() => addViewOf('board')}>Board</MenuItem>
            <MenuItem icon={<ListIcon size={16} />} onClick={() => addViewOf('list')}>List</MenuItem>
          </Popover>
        )}
        <span className="spacer" />
        <FilterMenu db={db} />
        <SortMenu db={db} />
        <FieldsMenu db={db} />
        {canEdit && <button className="btn primary small" onClick={() => addRow()}><Plus size={15} />New</button>}
      </div>
      {rowsQ.isPending ? null : view.type === 'table' ? <TableView db={db} /> : view.type === 'board' ? <BoardView db={db} /> : <ListView db={db} />}
    </div>
  );
}

// ---------- Filter / sort / fields ----------
const OPS: Record<string, [FilterOp, string][]> = {
  text: [['contains', 'contains'], ['not_contains', 'doesn’t contain'], ['eq', 'is'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  select: [['eq', 'is'], ['neq', 'is not'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  multi: [['contains', 'contains'], ['not_contains', 'doesn’t contain'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  date: [['eq', 'is'], ['lt', 'is before'], ['gt', 'is after'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  checkbox: [['checked', 'is checked'], ['unchecked', 'is not checked']],
};
const opGroup = (t: PropertyType | 'title') => (t === 'title' || t === 'text' || t === 'url' ? 'text' : t === 'number' ? 'number' : t === 'select' || t === 'status' ? 'select' : t === 'date' ? 'date' : t === 'checkbox' ? 'checkbox' : 'multi');
const noValue = (op: FilterOp) => op === 'is_empty' || op === 'is_not_empty' || op === 'checked' || op === 'unchecked';

function FilterMenu({ db }: { db: Db }) {
  const { view, schema, setView, canEdit } = db;
  const fields: { id: string; name: string; type: PropertyType | 'title' }[] = [{ id: 'title', name: 'Name', type: 'title' }, ...schema];
  const update = (i: number, p: Partial<Filter>) => setView({ filters: view.filters.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="btn ghost small" {...p}><ListFilter size={15} />Filter{view.filters.length > 0 && <span className="pill-count">{view.filters.length}</span>}</button>}>
      <div className="menu-pad" style={{ width: 430 }}>
        {view.filters.length === 0 && <span className="subtle">Show only rows that match conditions.</span>}
        {view.filters.map((f, i) => {
          const field = fields.find((x) => x.id === f.propertyId) ?? fields[0];
          const prop = schema.find((p) => p.id === f.propertyId);
          const group = opGroup(field.type);
          return (
            <div key={i} className="row" style={{ gap: 6 }}>
              <select className="select small" style={{ width: 120 }} aria-label="Property" disabled={!canEdit} value={field.id}
                onChange={(e) => { const nf = fields.find((x) => x.id === e.target.value)!; update(i, { propertyId: nf.id, op: OPS[opGroup(nf.type)][0][0], value: undefined }); }}>
                {fields.filter((x) => x.type !== 'person' && x.type !== 'relation').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select className="select small" style={{ width: 120 }} aria-label="Condition" disabled={!canEdit} value={f.op} onChange={(e) => update(i, { op: e.target.value as FilterOp })}>
                {OPS[group].map(([op, label]) => <option key={op} value={op}>{label}</option>)}
              </select>
              {noValue(f.op) ? <span className="grow" /> : prop && hasOptions(prop.type) ? (
                <select className="select small grow" aria-label="Value" disabled={!canEdit} value={String(f.value ?? '')} onChange={(e) => update(i, { value: e.target.value || undefined })}>
                  <option value="">Choose…</option>{prop.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <input className="input small grow" aria-label="Value" disabled={!canEdit} type={group === 'number' ? 'number' : group === 'date' ? 'date' : 'text'} value={String(f.value ?? '')}
                  onChange={(e) => update(i, { value: e.target.value === '' ? undefined : group === 'number' ? Number(e.target.value) : e.target.value })} />
              )}
              {canEdit && <button className="icon-btn" aria-label="Remove filter" onClick={() => setView({ filters: view.filters.filter((_, j) => j !== i) })}><X size={15} /></button>}
            </div>
          );
        })}
        {canEdit && <button className="btn ghost small" style={{ justifySelf: 'start' }} onClick={() => setView({ filters: [...view.filters, { propertyId: 'title', op: 'contains' }] })}><Plus size={15} />Add Filter</button>}
      </div>
    </Popover>
  );
}

function SortMenu({ db }: { db: Db }) {
  const { view, schema, setView, canEdit } = db;
  const fields = [{ id: 'title', name: 'Name' }, ...schema.map((p) => ({ id: p.id, name: p.name })), { id: 'createdAt', name: 'Created' }, { id: 'updatedAt', name: 'Last edited' }];
  const update = (i: number, p: Partial<Sort>) => setView({ sorts: view.sorts.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="btn ghost small" {...p}><ArrowDownUp size={15} />Sort{view.sorts.length > 0 && <span className="pill-count">{view.sorts.length}</span>}</button>}>
      <div className="menu-pad" style={{ width: 340 }}>
        {view.sorts.length === 0 && <span className="subtle">Rows are in manual order.</span>}
        {view.sorts.map((x, i) => (
          <div key={i} className="row" style={{ gap: 6 }}>
            <select className="select small grow" aria-label="Sort by" disabled={!canEdit} value={x.propertyId} onChange={(e) => update(i, { propertyId: e.target.value })}>
              {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select className="select small" style={{ width: 120 }} aria-label="Direction" disabled={!canEdit} value={x.dir} onChange={(e) => update(i, { dir: e.target.value as Sort['dir'] })}>
              <option value="asc">Ascending</option><option value="desc">Descending</option>
            </select>
            {canEdit && <button className="icon-btn" aria-label="Remove sort" onClick={() => setView({ sorts: view.sorts.filter((_, j) => j !== i) })}><X size={15} /></button>}
          </div>
        ))}
        {canEdit && <button className="btn ghost small" style={{ justifySelf: 'start' }} onClick={() => setView({ sorts: [...view.sorts, { propertyId: 'title', dir: 'asc' }] })}><Plus size={15} />Add Sort</button>}
      </div>
    </Popover>
  );
}

function FieldsMenu({ db }: { db: Db }) {
  const { view, schema, setView } = db;
  if (!db.canEdit) return null;
  const hidden = view.hidden ?? [];
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="btn ghost small" {...p}><SlidersHorizontal size={15} />Properties</button>}>
      <div className="menu-label">Shown in this view</div>
      {schema.map((p) => (
        <MenuItem key={p.id} keepOpen icon={<PropIcon type={p.type} />} hint={hidden.includes(p.id) ? <EyeOff size={14} /> : <Check size={15} />}
          onClick={() => setView({ hidden: hidden.includes(p.id) ? hidden.filter((h) => h !== p.id) : [...hidden, p.id] })}>{p.name}</MenuItem>
      ))}
      {schema.length === 0 && <div className="menu-label" style={{ fontWeight: 400 }}>No properties yet.</div>}
    </Popover>
  );
}

// ---------- Property (column) menu ----------
function PropertyMenu({ db, prop, close }: { db: Db; prop: Property; close: () => void }) {
  const s = useShell();
  const ui = useUi();
  const update = (p: Partial<Property>) => db.setSchema(db.schema.map((x) => (x.id === prop.id ? { ...x, ...p } : x)));
  const dbs = (s.tree?.nodes ?? []).filter((n) => n.kind === 'database');
  return (
    <div style={{ width: 270 }}>
      <div className="menu-pad">
        <input className="input small" autoFocus aria-label="Property name" defaultValue={prop.name} onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== prop.name) update({ name: n }); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <select className="select small" aria-label="Property type" value={prop.type} onChange={(e) => {
          const type = e.target.value as PropertyType;
          update({ type, options: hasOptions(type) ? (prop.options ?? (type === 'status' ? [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }] : [])) : undefined });
        }}>
          {TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        {prop.type === 'relation' && (
          <select className="select small" aria-label="Linked database" value={prop.relationDatabaseId ?? ''} onChange={(e) => update({ relationDatabaseId: e.target.value || undefined })}>
            <option value="">Link to database…</option>{dbs.map((d) => <option key={d.id} value={d.id}>{d.icon} {d.title || 'Untitled'}</option>)}
          </select>
        )}
      </div>
      {hasOptions(prop.type) && (
        <>
          <div className="menu-label">Options</div>
          {(prop.options ?? []).map((o) => (
            <div key={o.id} className="opt-row" style={{ padding: '2px 6px' }}>
              <Popover trigger={(p) => <button className="icon-btn" aria-label={`Colour of ${o.name}`} {...p}><span className={`chip ${o.color}`} style={{ width: 16, height: 16, padding: 0, borderRadius: '50%' }} /></button>}>
                <div className="color-dots" style={{ padding: 6, width: 130 }}>
                  {COLORS.map((c) => <button key={c} aria-label={c} className={`chip ${c}${c === o.color ? ' on' : ''}`} style={{ padding: 0 }} onClick={() => update({ options: prop.options!.map((x) => (x.id === o.id ? { ...x, color: c } : x)) })} />)}
                </div>
              </Popover>
              <input className="input small" aria-label="Option name" defaultValue={o.name} onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== o.name) update({ options: prop.options!.map((x) => (x.id === o.id ? { ...x, name: n } : x)) }); }} />
              <button className="icon-btn" aria-label={`Delete option ${o.name}`} onClick={() => update({ options: prop.options!.filter((x) => x.id !== o.id) })}><X size={14} /></button>
            </div>
          ))}
          <div style={{ padding: '4px 6px' }}>
            <input className="input small" placeholder="Add an option…" aria-label="Add an option" onKeyDown={(e) => { const n = e.currentTarget.value.trim(); if (e.key === 'Enter' && n) { db.addOption(prop.id, n); e.currentTarget.value = ''; } }} />
          </div>
        </>
      )}
      <div className="menu-sep" />
      <MenuItem icon={<EyeOff size={16} />} onClick={() => db.setView({ hidden: [...(db.view.hidden ?? []), prop.id] })}>Hide in This View</MenuItem>
      <MenuItem danger icon={<Trash2 size={16} />} onClick={async () => {
        close();
        if (await ui.confirm({ title: `Delete the “${prop.name}” property?`, body: 'Its values are removed from every row.', action: 'Delete Property', danger: true })) db.setSchema(db.schema.filter((x) => x.id !== prop.id));
      }}>Delete Property</MenuItem>
    </div>
  );
}

function AddProperty({ db }: { db: Db }) {
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="th-btn" style={{ width: 44, justifyContent: 'center' }} aria-label="Add a property" title="Add a property" {...p}><Plus size={16} /></button>}>
      <div className="menu-label">New property</div>
      {TYPES.map((t) => (
        <MenuItem key={t.type} icon={<PropIcon type={t.type} />} onClick={() => db.setSchema([...db.schema, {
          id: uid(), name: t.label, type: t.type,
          options: t.type === 'status' ? [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }] : hasOptions(t.type) ? [] : undefined,
        }])}>{t.label}</MenuItem>
      ))}
    </Popover>
  );
}

// ---------- Views ----------
function TitleInput({ row, db }: { row: Row; db: Db }) {
  return (
    <input key={row.title} className="cell-input" defaultValue={row.title} placeholder="Untitled" aria-label="Name" readOnly={!db.canEdit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onBlur={(e) => { if (e.target.value !== row.title) db.patchRow(row.id, { title: e.target.value }); }} />
  );
}

function TableView({ db }: { db: Db }) {
  const { view, schema, shown, canEdit } = db;
  const cols = schema.filter((p) => !(view.hidden ?? []).includes(p.id));
  const [widths, setWidths] = useState<Record<string, number>>(view.widths ?? {});
  useEffect(() => setWidths(view.widths ?? {}), [view.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const w = (id: string) => widths[id] ?? (id === 'title' ? 300 : 180);
  const startResize = (id: string, e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = w(id);
    let latest = w0;
    const move = (ev: PointerEvent) => { latest = Math.max(90, w0 + ev.clientX - x0); setWidths((prev) => ({ ...prev, [id]: latest })); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); db.setView({ widths: { ...widths, [id]: latest } }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <div className="tbl-wrap">
      <table className="tbl" style={{ width: w('title') + cols.reduce((a, c) => a + w(c.id), 0) + 44 }}>
        <colgroup><col style={{ width: w('title') }} />{cols.map((c) => <col key={c.id} style={{ width: w(c.id) }} />)}<col style={{ width: 44 }} /></colgroup>
        <thead><tr>
          <th><div className="th-btn"><PropIcon type="title" /><span>Name</span></div>{canEdit && <div className="col-resize" onPointerDown={(e) => startResize('title', e)} />}</th>
          {cols.map((c) => (
            <th key={c.id}>
              {canEdit ? (
                <Popover trigger={(p) => <button className="th-btn" {...p}><PropIcon type={c.type} /><span>{c.name}</span></button>}>{(close) => <PropertyMenu db={db} prop={c} close={close} />}</Popover>
              ) : <div className="th-btn"><PropIcon type={c.type} /><span>{c.name}</span></div>}
              {canEdit && <div className="col-resize" onPointerDown={(e) => startResize(c.id, e)} />}
            </th>
          ))}
          <th>{canEdit && <AddProperty db={db} />}</th>
        </tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} data-row={r.id}>
              <td><div className="title-cell">
                <TitleInput row={r} db={db} />
                <Link className="open" to={`/w/${db.wid}/p/${r.id}`} aria-label={`Open ${r.title || 'Untitled'}`}><ArrowUpRight size={13} />Open</Link>
              </div></td>
              {cols.map((c) => (
                <td key={c.id}>
                  <PropValueEditor prop={c} value={r.props[c.id] ?? null} editable={canEdit} users={db.users} wid={db.wid}
                    onChange={(v) => db.patchRow(r.id, { props: { [c.id]: v } })} onAddOption={(name) => db.addOption(c.id, name)} />
                </td>
              ))}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && <button className="add-row" onClick={() => db.addRow()}><Plus size={15} />New row</button>}
      {shown.length === 0 && !canEdit && <div className="empty">No rows.</div>}
      <div className="tbl-foot">{shown.length} {shown.length === 1 ? 'row' : 'rows'}{shown.length !== db.rows.length ? ` of ${db.rows.length}` : ''}</div>
    </div>
  );
}

function CardProps({ row, db, skip }: { row: Row; db: Db; skip?: string }) {
  const props = db.schema.filter((p) => p.id !== skip && !(db.view.hidden ?? []).includes(p.id));
  const nodes = props.map((p) => {
    const v = row.props[p.id] ?? null;
    if (v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) return null;
    return <PropValueView key={p.id} prop={p} value={v} users={db.users} />;
  }).filter(Boolean);
  return nodes.length ? <div className="ps">{nodes}</div> : null;
}

function BoardView({ db }: { db: Db }) {
  const { view, schema, shown, canEdit } = db;
  const group = schema.find((p) => p.id === view.groupBy && (p.type === 'select' || p.type === 'status'));
  const [over, setOver] = useState<string | null>(null);
  const drag = useRef<string | null>(null);
  if (!group) {
    return <div className="empty"><Kanban size={22} />A board groups rows by a Select or Status property.
      {canEdit && <button className="btn" onClick={() => {
        const p: Property = { id: uid(), name: 'Status', type: 'status', options: [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }] };
        db.setSchema([...schema, p]); setTimeout(() => db.setView({ groupBy: p.id }), 50);
      }}>Add a Status Property</button>}</div>;
  }
  const columns: { id: string; opt: SelectOption | null }[] = [...(group.options ?? []).map((o) => ({ id: o.id, opt: o })), { id: '', opt: null }];
  return (
    <div className="board">
      {columns.map((col) => {
        const rows = shown.filter((r) => String(r.props[group.id] ?? '') === col.id);
        if (!col.opt && rows.length === 0) return null;
        return (
          <div key={col.id} className={`col${over === col.id ? ' over' : ''}`}
            onDragOver={(e) => { if (drag.current) { e.preventDefault(); setOver(col.id); } }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (drag.current) db.patchRow(drag.current, { props: { [group.id]: col.id || null } }); drag.current = null; }}>
            <div className="col-head">
              {col.opt ? <Chip opt={col.opt} status={group.type === 'status'} /> : <span className="muted">No {group.name}</span>}
              <span className="n">{rows.length}</span><span className="grow" />
              {canEdit && <button className="icon-btn" aria-label={`Add to ${col.opt?.name ?? 'no ' + group.name}`} onClick={() => db.addRow({ [group.id]: col.id || null })}><Plus size={15} /></button>}
            </div>
            {rows.map((r) => (
              <Link key={r.id} to={`/w/${db.wid}/p/${r.id}`} className="kcard" draggable={canEdit} onDragStart={() => { drag.current = r.id; }} onDragEnd={() => { drag.current = null; setOver(null); }}>
                <span className="t"><span className="emoji">{r.icon}</span> {r.title || 'Untitled'}</span>
                <CardProps row={r} db={db} skip={group.id} />
              </Link>
            ))}
            {canEdit && <button className="add-row" style={{ height: 30, borderRadius: 'var(--r-s)' }} onClick={() => db.addRow({ [group.id]: col.id || null })}><Plus size={15} />New</button>}
          </div>
        );
      })}
    </div>
  );
}

function ListView({ db }: { db: Db }) {
  return (
    <div className="list">
      {db.shown.map((r) => (
        <Link key={r.id} className="list-row" to={`/w/${db.wid}/p/${r.id}`}>
          <PageIcon icon={r.icon} kind="page" /><span className="t">{r.title || 'Untitled'}</span><CardProps row={r} db={db} />
        </Link>
      ))}
      {db.shown.length === 0 && <div className="empty"><FilterIcon size={20} />No rows{db.rows.length ? ' match this view' : ' yet'}.</div>}
      {db.canEdit && <button className="add-row" onClick={() => db.addRow()}><Plus size={15} />New row</button>}
    </div>
  );
}

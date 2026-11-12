import { useQueries } from '@tanstack/react-query';
import {
  ArrowLeftRight, Calendar, Check, CheckSquare, ChevronDown, CircleDot, Hash, Link2, Plus, Tags, Type, User as UserIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type {
  OptionColor, Page, Property, PropertyType, Props, PropValue, Row, SelectOption, View,
} from '../../../shared/types.ts';
import { get, useRows } from '../api.ts';
import { Avatar, Popover } from '../ui.tsx';

export type WsUser = { id: string; name: string; color: string };
export const COLORS: OptionColor[] = ['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'red'];
export const TYPES: { type: PropertyType; label: string }[] = [
  { type: 'text', label: 'Text' }, { type: 'number', label: 'Number' }, { type: 'select', label: 'Select' },
  { type: 'multi_select', label: 'Multi-select' }, { type: 'status', label: 'Status' }, { type: 'date', label: 'Date' },
  { type: 'checkbox', label: 'Checkbox' }, { type: 'url', label: 'Link' }, { type: 'person', label: 'Person' }, { type: 'relation', label: 'Relation' },
];
export const hasOptions = (t: PropertyType) => t === 'select' || t === 'multi_select' || t === 'status';
export const isMulti = (t: PropertyType) => t === 'multi_select' || t === 'person' || t === 'relation';

export function PropIcon({ type, size = 15 }: { type: PropertyType | 'title'; size?: number }) {
  const I = { title: Type, text: Type, number: Hash, select: ChevronDown, multi_select: Tags, status: CircleDot, date: Calendar, checkbox: CheckSquare, url: Link2, person: UserIcon, relation: ArrowLeftRight }[type];
  return <I size={size} aria-hidden style={{ flex: 'none' }} />;
}

export function Chip({ opt, status }: { opt: SelectOption; status?: boolean }) {
  return <span className={`chip ${opt.color}${status ? ' status' : ''}`}>{opt.name}</span>;
}

export function fmtDate(v: string) {
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
    case 'relation': {
      const ids = value as string[];
      return <>{ids.slice(0, 3).map((id) => <span key={id} className={`marker ${markerColor(id)}`}>{relTitles?.get(id) ?? '…'}</span>)}{ids.length > 3 && <span className="meta-text">+{ids.length - 3}</span>}</>;
    }
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
    return <input className={`cell-input${value ? '' : ' blank'}`} type="date" aria-label={prop.name} value={value ? String(value).slice(0, 10) : ''} onChange={(e) => onChange(e.target.value || null)} />;
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

export function ChoiceList({ choices, selected, onPick, onCreate, emptyText }: {
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


// ---------- Shared database context ----------
export interface Db {
  page: Page; schema: Property[]; view: View; views: View[]; rows: Row[]; shown: Row[]; canEdit: boolean; users: WsUser[]; wid: string;
  relTitles: Map<string, string>;
  /** Link target for opening a row as a page. */
  rowHref: (rowId: string) => string;
  setSchema: (s: Property[]) => void; setView: (patch: Partial<View>) => void;
  patchRow: (id: string, body: { title?: string; props?: Props }) => void;
  addRow: (props?: Props) => Promise<Row | null>;
  moveRow: (id: string, afterId: string | null) => void;
  addOption: (propId: string, name: string) => SelectOption;
}

/** Titles of every row linked from this schema's relation properties, keyed by row id. */
export function useRelTitles(schema: Property[]): Map<string, string> {
  const ids = [...new Set(schema.filter((p) => p.type === 'relation' && p.relationDatabaseId).map((p) => p.relationDatabaseId!))];
  const results = useQueries({ queries: ids.map((id) => ({ queryKey: ['rows', id], queryFn: () => get<Row[]>(`/api/pages/${id}/rows`), staleTime: 30_000 })) });
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Map(results.flatMap((r) => (r.data ?? []).map((row) => [row.id, `${row.icon ? row.icon + ' ' : ''}${row.title || 'Untitled'}`] as [string, string]))), [stamp]);
}

const MARKER_COLORS: OptionColor[] = ['blue', 'green', 'purple', 'orange', 'teal', 'pink', 'brown', 'red', 'yellow'];
/** A stable colour for a linked row, so the same project always wears the same marker. */
export function markerColor(id: string): OptionColor {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return MARKER_COLORS[h % MARKER_COLORS.length];
}

export const isEmptyValue = (v: PropValue | undefined) => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);

/** Which properties a card shows: the view's choice, else the compact ones (no long text or links). */
export function cardProps(db: Pick<Db, 'schema' | 'view'>, skip?: string): Property[] {
  const chosen = db.view.cardProps;
  const list = chosen
    ? chosen.map((id) => db.schema.find((p) => p.id === id)).filter(Boolean) as Property[]
    : [
        // The owning project (or similar) leads as a coloured marker, then the compact fields.
        ...db.schema.filter((p) => p.type === 'relation' && /project|parent|area|client|epic/i.test(p.name)).slice(0, 1),
        ...db.schema.filter((p) => ['status', 'select', 'date', 'person', 'multi_select'].includes(p.type)).slice(0, 4),
      ];
  return list.filter((p) => p.id !== skip);
}

/** Compact property line for cards: relations as coloured markers, options as chips, dates and people small. */
export function CardMeta({ row, db, skip }: { row: Row; db: Db; skip?: string }) {
  const nodes: ReactNode[] = [];
  for (const p of cardProps(db, skip)) {
    const v = row.props[p.id];
    if (isEmptyValue(v)) continue;
    if (p.type === 'relation') {
      const ids = v as string[];
      ids.slice(0, 2).forEach((id) => nodes.push(<span key={p.id + id} className={`marker ${markerColor(id)}`} title={p.name}>{db.relTitles.get(id) ?? '…'}</span>));
      if (ids.length > 2) nodes.push(<span key={p.id + 'more'} className="meta-text" title={p.name}>+{ids.length - 2}</span>);
    } else if (p.type === 'date') {
      nodes.push(<span key={p.id} className="meta-text" title={p.name}><Calendar size={12} />{fmtDate(String(v))}</span>);
    } else if (p.type === 'person') {
      (v as string[]).forEach((id) => { const u = db.users.find((x) => x.id === id); if (u) nodes.push(<span key={p.id + id} title={`${p.name}: ${u.name}`}><Avatar name={u.name} color={u.color} /></span>); });
    } else if (p.type === 'text' || p.type === 'url' || p.type === 'number') {
      nodes.push(<span key={p.id} className="meta-text clip" title={p.name}>{String(v)}</span>);
    } else {
      nodes.push(<PropValueView key={p.id} prop={p} value={v ?? null} users={db.users} relTitles={db.relTitles} />);
    }
  }
  return nodes.length ? <div className="card-meta">{nodes}</div> : null;
}

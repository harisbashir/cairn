import type { OptionColor, Property, PropValue, Row, SelectOption, View } from '../../../shared/types.ts';
import { markerColor } from './kit.tsx';

/** One group of rows on a board or in the phone strip. `id` '' is the "no value" group. */
export interface Group {
  id: string;
  label: string;
  /** Option groups render as their chip; others get a marker colour. */
  opt?: SelectOption;
  color?: OptionColor;
}

/** Property types a board can group by. Every type works: free text and numbers group by their exact value. */
export const GROUPABLE: Property['type'][] = ['status', 'select', 'multi_select', 'relation', 'person', 'checkbox', 'date', 'text', 'number', 'url'];
export const groupableProps = (schema: Property[]) => schema.filter((p) => GROUPABLE.includes(p.type));

const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/** The group ids a row belongs to. Multi-value properties (tags, people, linked pages) put a row in each of its groups. */
export function groupKeys(row: Row, prop: Property): string[] {
  const v = row.props[prop.id];
  switch (prop.type) {
    case 'checkbox': return [v ? 'yes' : 'no'];
    case 'date': return [typeof v === 'string' && /^\d{4}-\d{2}/.test(v) ? v.slice(0, 7) : ''];
    case 'multi_select': case 'person': case 'relation': return Array.isArray(v) && v.length ? v : [''];
    default: return v === null || v === undefined || v === '' ? [''] : [String(v)];
  }
}

/** Whether moving a card between groups can set the value directly (a month or a number range can't). */
export const canMoveBetween = (prop: Property) => prop.type !== 'date';

/** The new value for a row moved from group `from` to group `to`. */
export function moveValue(row: Row, prop: Property, from: string, to: string): PropValue {
  const v = row.props[prop.id];
  switch (prop.type) {
    case 'checkbox': return to === 'yes';
    case 'number': return to === '' ? null : Number(to);
    case 'multi_select': case 'person': case 'relation': {
      const list = (Array.isArray(v) ? v : []).filter((x) => x !== from && x !== to);
      return to ? [...list, to] : list;
    }
    default: return to || null;
  }
}

/** Props for a new row created inside a group. */
export function newRowValue(prop: Property, group: string): PropValue {
  if (prop.type === 'date') return group ? `${group}-01` : null;
  return moveValue({ props: {} } as Row, prop, '', group);
}

interface Lookup { users: { id: string; name: string }[]; relTitles: Map<string, string> }

/** Every group for a property, in the view's own order, hidden ones removed. Groups without rows are kept only for options. */
export function groupsFor(prop: Property, rows: Row[], view: Pick<View, 'columnOrder' | 'hiddenColumns'>, lookup: Lookup): Group[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of groupKeys(r, prop)) seen.add(k);
  let all: Group[];
  switch (prop.type) {
    case 'select': case 'status': case 'multi_select':
      all = (prop.options ?? []).map((o) => ({ id: o.id, label: o.name, opt: o }));
      break;
    case 'checkbox':
      all = [{ id: 'yes', label: `${prop.name}: Yes`, color: 'green' }, { id: 'no', label: `${prop.name}: No`, color: 'gray' }];
      break;
    case 'person':
      all = [...seen].filter(Boolean).map((id) => ({ id, label: lookup.users.find((u) => u.id === id)?.name ?? 'Former member', color: markerColor(id) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      break;
    case 'relation':
      all = [...seen].filter(Boolean).map((id) => ({ id, label: lookup.relTitles.get(id) ?? 'Untitled', color: markerColor(id) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      break;
    case 'date':
      all = [...seen].filter(Boolean).sort().reverse().map((id) => ({ id, label: monthLabel(id) }));
      break;
    case 'number':
      all = [...seen].filter(Boolean).sort((a, b) => Number(a) - Number(b)).map((id) => ({ id, label: id }));
      break;
    default:
      all = [...seen].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((id) => ({ id, label: id }));
  }
  if (prop.type !== 'checkbox') all.push({ id: '', label: `No ${prop.name}` });
  const order = view.columnOrder ?? [];
  const rank = (id: string) => { const i = order.indexOf(id); return i === -1 ? order.length + all.findIndex((c) => c.id === id) : i; };
  const hidden = view.hiddenColumns ?? [];
  return all.sort((a, b) => rank(a.id) - rank(b.id)).filter((g) => !hidden.includes(g.id));
}

/** All groups including hidden ones, for the "Hidden columns" list. */
export function allGroupLabel(prop: Property, id: string, lookup: Lookup): string {
  if (!id) return `No ${prop.name}`;
  switch (prop.type) {
    case 'select': case 'status': case 'multi_select': return prop.options?.find((o) => o.id === id)?.name ?? id;
    case 'checkbox': return `${prop.name}: ${id === 'yes' ? 'Yes' : 'No'}`;
    case 'person': return lookup.users.find((u) => u.id === id)?.name ?? 'Former member';
    case 'relation': return lookup.relTitles.get(id) ?? 'Untitled';
    case 'date': return monthLabel(id);
    default: return id;
  }
}

export const inGroup = (row: Row, prop: Property, id: string) => groupKeys(row, prop).includes(id);

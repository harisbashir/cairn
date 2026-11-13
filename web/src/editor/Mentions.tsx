// The @-menu: pages (inserted as pageLink), people and dates (inserted as mention nodes).
import { CalendarDays, FileText } from 'lucide-react';
import type { TreeNode } from '../../../shared/types.ts';
import { get } from '../api.ts';
import type { MenuItemDef } from './blocks.tsx';

type Mentionables = { pages: { id: string; title: string; icon: string; path: string }[]; people: { id: string; name: string; color: string }[] };

// People colours for mention pills. Filled from the @-menu and from the workspace's user list.
const people = new Map<string, string>();
export function personColor(id: string): string | undefined { return people.get(id); }
export function rememberPeople(list: { id: string; color: string }[]) {
  let changed = false;
  for (const u of list) if (people.get(u.id) !== u.color) { people.set(u.id, u.color); changed = true; }
  if (changed) window.dispatchEvent(new Event('cairn:people'));
}

// ---------- Dates ----------
const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fromIso = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };

/** Absolute label stored in the document (and used in Markdown): "16 Nov 2026". */
export function storedDateLabel(iso: string) {
  return fromIso(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What a date pill shows: Today / Tomorrow / Yesterday, else "Mon 16 Nov" (plus the year when it isn't this year). */
export function dateLabel(iso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = fromIso(iso);
  const diff = Math.round((d.getTime() - startOfToday().getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const monthIndex = (w: string) => (w.length >= 3 ? MONTHS.findIndex((m) => w.startsWith(m)) : -1);

/** Understands "12 Dec", "Dec 12", "12 December 2027", "2026-12-12", "friday", "next fri". */
export function parseDate(q: string): string | null {
  const s = q.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  const today = startOfToday();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.getMonth() === +m[2] - 1 ? isoDay(d) : null; }
  const withYear = (day: number, month: number, year?: number) => {
    if (month < 0 || day < 1 || day > 31) return null;
    let d = new Date(year ?? today.getFullYear(), month, day);
    if (d.getMonth() !== month) return null;
    // Without a year, a date that has already passed this year most likely means next year.
    if (year === undefined && d < addDays(today, -30)) d = new Date(today.getFullYear() + 1, month, day);
    return isoDay(d);
  };
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/.exec(s);
  if (m) return withYear(+m[1], monthIndex(m[2]), m[3] ? +m[3] : undefined);
  m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s);
  if (m && monthIndex(m[1]) >= 0) return withYear(+m[2], monthIndex(m[1]), m[3] ? +m[3] : undefined);
  m = /^(next )?([a-z]{3,})$/.exec(s);
  if (m) {
    const wd = DAYS.findIndex((d) => d.startsWith(m![2]));
    if (wd >= 0) {
      // "friday" and "next friday" both mean the coming one (never today).
      return isoDay(addDays(today, (wd - today.getDay() + 7) % 7 || 7));
    }
  }
  return null;
}

function dateItems(query: string): MenuItemDef[] {
  const q = query.trim().toLowerCase();
  const today = startOfToday();
  const nextMonday = addDays(today, ((1 - today.getDay() + 7) % 7) || 7);
  const fixed = [
    { name: 'Today', iso: isoDay(today) },
    { name: 'Tomorrow', iso: isoDay(addDays(today, 1)) },
    { name: 'Next Monday', iso: isoDay(nextMonday) },
  ];
  const out = fixed.filter((f) => !q || f.name.toLowerCase().startsWith(q) || (q.length >= 3 && f.name.toLowerCase().includes(q)));
  const parsed = parseDate(q);
  if (parsed && !out.some((o) => o.iso === parsed)) out.unshift({ name: dateLabel(parsed), iso: parsed });
  return out.map((d) => ({
    id: `date:${d.iso}`, section: 'Dates', title: d.name,
    desc: fromIso(d.iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    icon: <CalendarDays size={16} />,
    run: (editor, range) => {
      editor.chain().focus().insertContentAt(range, [{ type: 'mention', attrs: { kind: 'date', id: d.iso, label: storedDateLabel(d.iso) } }, { type: 'text', text: ' ' }]).run();
    },
  }));
}

const cache = new Map<string, Promise<Mentionables>>();

/** Items for the @-menu, grouped as Pages, People, Dates. */
export async function mentionItems(wid: string, query: string, localPages: TreeNode[]): Promise<MenuItemDef[]> {
  const key = `${wid}\n${query.trim().toLowerCase()}`;
  if (!cache.has(key)) {
    cache.set(key, get<Mentionables>(`/api/workspaces/${wid}/mentionables?q=${encodeURIComponent(query.trim())}`));
    setTimeout(() => cache.delete(key), 20_000);
  }
  let data: Mentionables;
  try { data = await cache.get(key)!; } catch {
    cache.delete(key);
    const q = query.toLowerCase();
    data = { pages: localPages.filter((p) => (p.title || 'Untitled').toLowerCase().includes(q)).slice(0, 8).map((p) => ({ id: p.id, title: p.title, icon: p.icon, path: '' })), people: [] };
  }
  rememberPeople(data.people);
  const pages: MenuItemDef[] = data.pages.slice(0, 6).map((p) => ({
    id: `page:${p.id}`, section: 'Pages', title: p.title || 'Untitled', desc: p.path || undefined,
    icon: p.icon ? <span className="emoji mention-ico">{p.icon}</span> : <FileText size={16} />,
    run: (editor, range) => { editor.chain().focus().insertContentAt(range, [{ type: 'pageLink', attrs: { pageId: p.id, title: p.title || 'Untitled' } }, { type: 'text', text: ' ' }]).run(); },
  }));
  const ppl: MenuItemDef[] = data.people.slice(0, 5).map((u) => ({
    id: `user:${u.id}`, section: 'People', title: u.name,
    icon: <span className="mention-avatar" style={{ background: u.color }} aria-hidden>{u.name.trim().slice(0, 1).toUpperCase()}</span>,
    run: (editor, range) => { editor.chain().focus().insertContentAt(range, [{ type: 'mention', attrs: { kind: 'user', id: u.id, label: u.name } }, { type: 'text', text: ' ' }]).run(); },
  }));
  return [...pages, ...ppl, ...dateItems(query)];
}

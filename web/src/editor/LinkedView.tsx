// The `databaseView` block: a live view of a database inside a page, optionally narrowed to rows that link here.
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { ArrowUpRight, Database, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { applyView } from '../../../shared/query.ts';
import type { Filter, Page, Property, Props, Row, SelectOption, View } from '../../../shared/types.ts';
import { patch, post, qc, uid, useBootstrap, usePage, useRows, useWsUsers } from '../api.ts';
import { VIEWS } from '../db/DatabaseView.tsx';
import { COLORS, useRelTitles, type Db } from '../db/kit.tsx';
import { PhoneView } from '../db/PhoneView.tsx';
import { TableView } from '../db/TableView.tsx';
import { PageIcon, useShell } from '../Shell.tsx';
import { Switch, useIsPhone, useUi } from '../ui.tsx';
import { isoDay } from './Mentions.tsx';

export interface LinkedAttrs { databaseId: string; viewId: string | null; filters: Filter[]; title: string; limit: number }
const THIS = '@this';
const FALLBACK_VIEW: View = { id: 'default', name: 'Table', type: 'table', filters: [], sorts: [] };

export function LinkedView({ node, updateAttributes, deleteNode, editor, selected }: NodeViewProps) {
  const a = node.attrs as LinkedAttrs;
  const editable = editor.isEditable;
  return (
    <NodeViewWrapper className={`lv${selected ? ' selected' : ''}`} data-type="database-view" contentEditable={false}>
      {a.databaseId
        ? <Linked a={a} editable={editable} set={updateAttributes} remove={deleteNode} />
        : editable ? <Picker set={updateAttributes} remove={deleteNode} /> : null}
    </NodeViewWrapper>
  );
}

/** The page the block sits on, for "@this" filters. */
function useThisPage() {
  const { pid } = useParams();
  return pid ?? '';
}

/** A relation property of the database that points at the database this page is a row of (Tasks → Projects). */
function relationToHere(schema: Property[], thisPage: Page | undefined): Property | undefined {
  const rels = schema.filter((p) => p.type === 'relation');
  return rels.find((p) => thisPage?.kind === 'row' && p.relationDatabaseId === thisPage.parentId);
}

// ---------- Choosing a database, then a view ----------
function Picker({ set, remove }: { set: (a: Partial<LinkedAttrs>) => void; remove: () => void }) {
  const s = useShell();
  const thisId = useThisPage();
  const thisPage = usePage(thisId).data;
  const [q, setQ] = useState('');
  const [dbId, setDbId] = useState('');
  const dbs = (s.tree?.nodes ?? []).filter((n) => n.kind === 'database' && (n.title || 'Untitled').toLowerCase().includes(q.toLowerCase()));
  const db = usePage(dbId || undefined).data;
  const finish = (d: Page, viewId: string | null) => {
    const rel = relationToHere(d.schema, thisPage);
    set({ databaseId: d.id, viewId, filters: rel ? [{ propertyId: rel.id, op: 'contains', value: THIS }] : [], title: '', limit: 10 });
  };
  const single = !!db && db.views.length <= 1;
  const done = useRef(false);
  useEffect(() => { if (db && single && !done.current) { done.current = true; finish(db, db.views[0]?.id ?? null); } }); // eslint-disable-line react-hooks/exhaustive-deps
  if (single) return null;
  return (
    <div className="lv-picker">
      {!db ? (
        <>
          <div className="lv-picker-head"><Database size={16} /><b>Choose a database</b><span className="spacer" /><button className="btn ghost small" onClick={remove}>Cancel</button></div>
          <label className="lv-search"><Search size={15} /><input autoFocus placeholder="Search databases" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search databases" /></label>
          <div className="lv-options">
            {dbs.length === 0 && <div className="subtle lv-none">{q ? 'No database matches.' : 'This workspace has no databases yet.'}</div>}
            {dbs.slice(0, 30).map((n) => (
              <button key={n.id} type="button" className="menu-item" onClick={() => setDbId(n.id)}>
                <PageIcon icon={n.icon} kind="database" size={16} /><span className="grow">{n.title || 'Untitled'}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="lv-picker-head"><PageIcon icon={db.icon} kind="database" size={16} /><b>Which view of {db.title || 'Untitled'}?</b><span className="spacer" /><button className="btn ghost small" onClick={() => setDbId('')}>Back</button></div>
          <div className="lv-options">
            {db.views.map((v) => { const I = VIEWS[v.type]?.icon ?? Database; return (
              <button key={v.id} type="button" className="menu-item" onClick={() => finish(db, v.id)}><I size={16} /><span className="grow">{v.name}</span></button>
            ); })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- The live view ----------
function Linked({ a, editable, set, remove }: { a: LinkedAttrs; editable: boolean; set: (a: Partial<LinkedAttrs>) => void; remove: () => void }) {
  const page = usePage(a.databaseId);
  if (page.isPending) return <div className="lv-loading" />;
  if (page.isError || !page.data || page.data.kind !== 'database') {
    return (
      <div className="lv-missing">
        <Database size={16} /><span className="grow">This database isn’t available any more.</span>
        {editable && <button className="btn ghost small" onClick={remove}>Remove</button>}
      </div>
    );
  }
  return <LinkedInner db={page.data} a={a} editable={editable} set={set} remove={remove} />;
}

function LinkedInner({ db: dbPage, a, editable, set, remove }: { db: Page; a: LinkedAttrs; editable: boolean; set: (a: Partial<LinkedAttrs>) => void; remove: () => void }) {
  const s = useShell();
  const ui = useUi();
  const phone = useIsPhone();
  const thisId = useThisPage();
  const userId = useBootstrap().data?.user?.id;
  const rowsQ = useRows(dbPage.id);
  const users = useWsUsers(s.wid).data ?? [];
  const relTitles = useRelTitles(dbPage.schema);
  const box = useRef<HTMLDivElement>(null);
  const [extra, setExtra] = useState(0); // rows added here stay visible even past the limit
  const [menu, setMenu] = useState(false);
  const schema = dbPage.schema;
  const views = dbPage.views.length ? dbPage.views : [FALLBACK_VIEW];
  const baseView = views.find((v) => v.id === a.viewId) ?? views[0];
  const filters = useMemo(() => [...baseView.filters, ...(a.filters ?? [])], [baseView.filters, a.filters]);
  const view = useMemo<View>(() => ({ ...baseView, filters }), [baseView, filters]);
  const ctx = useMemo(() => ({ thisPageId: thisId, userId, today: isoDay(new Date()) }), [thisId, userId]);
  const rows = rowsQ.data ?? [];
  const all = useMemo(() => applyView(rows, view, schema, ctx), [rows, view, schema, ctx]);
  const limit = Math.max(1, a.limit || 10) + extra;
  const shown = useMemo(() => all.slice(0, limit), [all, limit]);
  const canEdit = !!dbPage.canEdit && !dbPage.deletedAt;
  const title = a.title || dbPage.title || 'Untitled';

  const saveSchema = (next: Property[]) => {
    qc.setQueryData<Page>(['page', dbPage.id], (old) => (old ? { ...old, schema: next } : old));
    patch(`/api/pages/${dbPage.id}`, { schema: next }).catch((err) => { ui.toast((err as Error).message); qc.invalidateQueries({ queryKey: ['page', dbPage.id] }); });
  };
  const resolve = (v: Filter['value']) => (v === THIS ? thisId : v === '@me' ? userId ?? null : v === '@today' ? ctx.today : v);
  const db: Db = {
    page: dbPage, schema, view, views, rows: all, shown, canEdit, users, wid: s.wid, relTitles, rowHref: (id) => `/w/${s.wid}/p/${id}`,
    setSchema: saveSchema, setView: () => {},
    patchRow: (id, body) => {
      qc.setQueryData<Row[]>(['rows', dbPage.id], (old) => old?.map((r) => (r.id === id ? { ...r, ...(body.title !== undefined ? { title: body.title } : {}), props: { ...r.props, ...body.props } } : r)));
      patch(`/api/pages/${id}`, body).then(() => qc.invalidateQueries({ queryKey: ['page', id] })).catch((err) => { ui.toast((err as Error).message); rowsQ.refetch(); });
    },
    addRow: async (props = {}) => {
      // New rows start out matching the view's simple filters (and link to this page), so they don't vanish.
      const preset: Props = {};
      for (const f of filters) {
        if (f.propertyId === 'title' || f.value === undefined) continue;
        const prop = schema.find((p) => p.id === f.propertyId);
        if (!prop) continue;
        const v = resolve(f.value);
        if (v === null || v === undefined || v === '') continue;
        const multi = ['relation', 'person', 'multi_select'].includes(prop.type);
        if (multi && (f.op === 'contains' || f.op === 'eq')) preset[prop.id] = [...new Set([...((preset[prop.id] as string[]) ?? []), String(v)])];
        else if (f.op === 'eq') preset[prop.id] = v;
      }
      try {
        const created = await post<Page>(`/api/workspaces/${s.wid}/pages`, { kind: 'row', parentId: dbPage.id, title: '', props: { ...preset, ...props } });
        const fresh = await rowsQ.refetch();
        setExtra((n) => n + 1);
        return fresh.data?.find((r) => r.id === created.id) ?? null;
      } catch (err) { ui.toast((err as Error).message); return null; }
    },
    moveRow: (id, afterId) => { post(`/api/pages/${id}/move`, { parentId: dbPage.id, afterId }).then(() => rowsQ.refetch()).catch((err) => ui.toast((err as Error).message)); },
    addOption: (propId, name) => {
      const prop = schema.find((p) => p.id === propId)!;
      const opt: SelectOption = { id: uid(), name, color: COLORS[(prop.options?.length ?? 0) % COLORS.length] };
      saveSchema(schema.map((p) => (p.id === propId ? { ...p, options: [...(p.options ?? []), opt] } : p)));
      return opt;
    },
  };
  const newRow = async () => {
    const row = await db.addRow();
    if (row) setTimeout(() => (box.current?.querySelector(`[data-row="${row.id}"] input`) as HTMLInputElement | null)?.focus(), 60);
  };

  const type = view.type;
  const cards = phone && view.phone !== 'same' && type !== 'gallery' && type !== 'chart' && type !== 'feed';
  const Body = cards ? PhoneView : VIEWS[type]?.Component ?? TableView;
  const narrowed = (a.filters ?? []).some((f) => f.value === THIS);

  return (
    <div className="lv-box" ref={box}>
      <div className="lv-head">
        <Link className="lv-title" to={`/w/${s.wid}/p/${dbPage.id}`} title={`Open ${dbPage.title || 'Untitled'}`}>
          <PageIcon icon={dbPage.icon} kind="database" size={16} /><span className="ell">{title}</span>
        </Link>
        {views.length > 1 && <span className="lv-view">{baseView.name}</span>}
        {narrowed && <span className="lv-view">Linked to this page</span>}
        <span className="spacer" />
        {canEdit && <button className="btn ghost small" onClick={newRow} aria-label={`New row in ${dbPage.title || 'Untitled'}`}><Plus size={15} /><span className="lv-hide-phone">New</span></button>}
        {editable && (
          <button className={`icon-btn${menu ? ' on' : ''}`} aria-label="Linked view settings" title="Linked view settings" aria-expanded={menu} onClick={() => setMenu(!menu)}><Settings2 size={16} /></button>
        )}
      </div>
      {menu && <Settings a={a} db={dbPage} views={views} set={set} remove={remove} close={() => setMenu(false)} />}
      <div className="lv-body">
        {rowsQ.isPending ? <div className="lv-loading" /> : all.length === 0 && type !== 'calendar' && type !== 'timeline' && type !== 'chart' ? (
          <div className="lv-empty">{narrowed ? 'No rows link to this page yet.' : 'No rows to show.'}{canEdit && <button className="btn ghost small" onClick={newRow}><Plus size={14} />New Row</button>}</div>
        ) : <Body db={db} />}
      </div>
      {all.length > shown.length && (
        <Link className="lv-more" to={`/w/${s.wid}/p/${dbPage.id}`}>Show all {all.length}<ArrowUpRight size={14} /></Link>
      )}
    </div>
  );
}

function Settings({ a, db, views, set, remove, close }: { a: LinkedAttrs; db: Page; views: View[]; set: (a: Partial<LinkedAttrs>) => void; remove: () => void; close: () => void }) {
  const s = useShell();
  const navigate = useNavigate();
  const thisId = useThisPage();
  const thisPage = usePage(thisId).data;
  const rels = db.schema.filter((p) => p.type === 'relation');
  const thisFilter = (a.filters ?? []).find((f) => f.value === THIS);
  const preferred = relationToHere(db.schema, thisPage) ?? rels[0];
  const others = (a.filters ?? []).filter((f) => f.value !== THIS);
  const setThis = (propId: string | null) => set({ filters: propId ? [...others, { propertyId: propId, op: 'contains', value: THIS }] : others });
  const [title, setTitle] = useState(a.title);
  return (
    <div className="lv-settings" role="group" aria-label="Linked view settings" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="lv-fields">
        <label className="field"><span>Title</span>
          <input className="input small" value={title} placeholder={db.title || 'Untitled'} onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { if (title !== a.title) set({ title: title.trim() }); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </label>
        {views.length > 1 && (
          <label className="field"><span>View</span>
            <select className="select small" value={a.viewId ?? views[0].id} onChange={(e) => set({ viewId: e.target.value })}>
              {views.map((v) => <option key={v.id} value={v.id}>{v.name === (VIEWS[v.type]?.label ?? v.type) ? v.name : `${v.name} (${VIEWS[v.type]?.label ?? v.type})`}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>Rows shown</span>
          <select className="select small" value={a.limit || 10} onChange={(e) => set({ limit: Number(e.target.value) })}>
            {[5, 10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {thisFilter && rels.length > 1 && (
          <label className="field"><span>Linked through</span>
            <select className="select small" value={thisFilter.propertyId} onChange={(e) => setThis(e.target.value)}>
              {rels.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {rels.length > 0 && (
        <div className="lv-switch">
          <span className="grow"><b>Only rows linked to this page</b><div className="subtle">Rows whose {(rels.find((p) => p.id === thisFilter?.propertyId) ?? preferred)?.name ?? 'relation'} includes this page. New rows link here.</div></span>
          <Switch on={!!thisFilter} onChange={(on) => setThis(on ? preferred.id : null)} label="Only rows linked to this page" />
        </div>
      )}
      <div className="lv-settings-foot">
        <button type="button" className="btn ghost small" onClick={() => navigate(`/w/${s.wid}/p/${db.id}`)}><ArrowUpRight size={15} />Open {db.title || 'database'}</button>
        <button type="button" className="btn ghost small danger" onClick={remove}><Trash2 size={15} />Remove block</button>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={close}>Done</button>
      </div>
    </div>
  );
}

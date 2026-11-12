import {
  BarChart3, CalendarDays, ChevronDown, GalleryHorizontalEnd, GanttChart, Kanban, LayoutGrid, List as ListIcon, Newspaper, Plus, Smartphone, Table2, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { applyView } from '../../../shared/query.ts';
import type { ChartConfig, Page, Property, Props, Row, SelectOption, View, ViewType } from '../../../shared/types.ts';
import { patch, post, qc, uid, usePage, useRows, useWsUsers } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { MenuItem, Popover, useIsPhone, useUi } from '../ui.tsx';
import { BoardView } from './BoardView.tsx';
import { CalendarView } from './CalendarView.tsx';
import { ChartView } from './ChartView.tsx';
import { FeedView } from './FeedView.tsx';
import { GalleryView } from './GalleryView.tsx';
import { COLORS, PropIcon, useRelTitles, type Db } from './kit.tsx';
import { groupableProps } from './groups.ts';
import { ListView } from './ListView.tsx';
import { FieldsMenu, FilterMenu, SortMenu } from './menus.tsx';
import { PhoneView } from './PhoneView.tsx';
import { TableView } from './TableView.tsx';
import { TimelineView } from './TimelineView.tsx';

void GalleryHorizontalEnd;

export const VIEWS: Record<ViewType, { label: string; hint: string; icon: ComponentType<{ size?: number }>; Component: ComponentType<{ db: Db }> }> = {
  table: { label: 'Table', hint: 'Rows and columns', icon: Table2, Component: TableView },
  board: { label: 'Board', hint: 'Cards grouped in columns', icon: Kanban, Component: BoardView },
  list: { label: 'List', hint: 'A simple, compact list', icon: ListIcon, Component: ListView },
  gallery: { label: 'Gallery', hint: 'Cards with cover images', icon: LayoutGrid, Component: GalleryView },
  calendar: { label: 'Calendar', hint: 'Rows on their dates', icon: CalendarDays, Component: CalendarView },
  timeline: { label: 'Timeline', hint: 'Bars across time', icon: GanttChart, Component: TimelineView },
  chart: { label: 'Chart', hint: 'Counts and totals at a glance', icon: BarChart3, Component: ChartView },
  feed: { label: 'Feed', hint: 'Rows as a stream of posts', icon: Newspaper, Component: FeedView },
};
const VIEW_TYPES = Object.keys(VIEWS) as ViewType[];
const STATUS_OPTIONS = (): SelectOption[] => [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }];

/** Fills in what a view type needs (a grouping, a date property, a chart) from the schema. */
function defaultsFor(type: ViewType, schema: Property[], current: Partial<View> = {}): Partial<View> {
  const group = schema.find((p) => p.type === 'status') ?? schema.find((p) => p.type === 'select');
  const date = schema.find((p) => p.type === 'date');
  const out: Partial<View> = { type };
  // A view still carrying its old type's default name ("Table") follows the new type, so a board isn't called Table.
  if (current.type && current.name === VIEWS[current.type].label) out.name = VIEWS[type].label;
  if (type === 'board' && !current.groupBy) out.groupBy = group?.id;
  if ((type === 'calendar' || type === 'timeline') && !current.dateProp) out.dateProp = date?.id;
  if (type === 'chart' && !current.chart) out.chart = { kind: 'bar', groupBy: group?.id ?? 'createdAt', measure: 'count' };
  return out;
}

type Save = (p: { schema?: Property[]; views?: View[] }, now?: boolean) => void;

function useDb(page: Page, canEdit: boolean, save: Save) {
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
  const relTitles = useRelTitles(schema);

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
      const created = await post<Page>(`/api/workspaces/${s.wid}/pages`, { kind: 'row', parentId: page.id, title: '', props: { ...preset, ...props } });
      const fresh = await rowsQ.refetch();
      return fresh.data?.find((r) => r.id === created.id) ?? null;
    } catch (err) { ui.toast((err as Error).message); return null; }
  };
  const moveRow: Db['moveRow'] = (id, afterId) => {
    post(`/api/pages/${id}/move`, { parentId: page.id, afterId }).then(() => rowsQ.refetch()).catch((err) => ui.toast((err as Error).message));
  };
  const addOption: Db['addOption'] = (propId, name) => {
    const prop = schema.find((p) => p.id === propId)!;
    const opt: SelectOption = { id: uid(), name, color: COLORS[(prop.options?.length ?? 0) % COLORS.length] };
    setSchema(schema.map((p) => (p.id === propId ? { ...p, options: [...(p.options ?? []), opt] } : p)));
    return opt;
  };
  const db: Db = {
    page, schema, view, views, rows, shown, canEdit, users, wid: s.wid, relTitles, rowHref: (id) => `/w/${s.wid}/p/${id}`,
    setSchema, setView, patchRow, addRow, moveRow, addOption,
  };
  return { db, views, setViews, pickView, loading: rowsQ.isPending };
}

function ViewBody({ db }: { db: Db }) {
  const phone = useIsPhone();
  const type = db.view.type;
  // Tables, boards, lists, calendars and timelines need width; on a phone they become a card list unless told otherwise.
  if (phone && db.view.phone !== 'same' && type !== 'gallery' && type !== 'chart' && type !== 'feed') return <PhoneView db={db} />;
  const C = VIEWS[type]?.Component ?? TableView;
  return <C db={db} />;
}

export function DatabaseView({ page, canEdit, save }: { page: Page; canEdit: boolean; save: Save }) {
  const { db, views, setViews, pickView, loading } = useDb(page, canEdit, save);
  const { view, schema } = db;
  const addViewOf = (type: ViewType) => {
    const v: View = { id: uid(), name: VIEWS[type].label, filters: [], sorts: [], ...defaultsFor(type, schema), type };
    setViews([...views, v]); pickView(v.id);
  };
  const focusNew = async () => {
    const row = await db.addRow();
    if (row) setTimeout(() => (document.querySelector(`[data-row="${row.id}"] input`) as HTMLInputElement | null)?.focus(), 30);
  };
  return (
    <div>
      <div className="db-bar">
        <div className="view-tabs">
          {views.map((v) => {
            const I = VIEWS[v.type]?.icon ?? Table2;
            return v.id === view.id && canEdit ? (
              <Popover key={v.id} trigger={(p) => <button className="view-tab active" {...p}><I size={15} />{v.name}<ChevronDown size={13} /></button>}>
                <ViewMenu db={db} canDelete={views.length > 1} onDelete={() => { setViews(views.filter((x) => x.id !== v.id)); pickView(''); }} />
              </Popover>
            ) : <button key={v.id} className={`view-tab${v.id === view.id ? ' active' : ''}`} onClick={() => pickView(v.id)}><I size={15} />{v.name}</button>;
          })}
          {canEdit && (
            <Popover trigger={(p) => <button className="icon-btn" aria-label="Add a view" title="Add a view" {...p}><Plus size={16} /></button>}>
              <div className="menu-label">New view</div>
              {VIEW_TYPES.map((t) => { const I = VIEWS[t].icon; return <MenuItem key={t} icon={<I size={16} />} hint={VIEWS[t].hint} onClick={() => addViewOf(t)}>{VIEWS[t].label}</MenuItem>; })}
            </Popover>
          )}
        </div>
        <span className="spacer" />
        <FilterMenu db={db} />
        <SortMenu db={db} />
        <FieldsMenu db={db} />
        {canEdit && <button className="btn primary small db-new" aria-label="New row" onClick={focusNew}><Plus size={15} /><span>New</span></button>}
      </div>
      {loading ? null : <ViewBody db={db} />}
    </div>
  );
}

function PropSelect({ label, value, onChange, props, none }: { label: string; value: string | undefined; onChange: (id: string | undefined) => void; props: Property[]; none?: string }) {
  return (
    <label className="field"><span>{label}</span>
      <select className="select small" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        {(none || !props.some((p) => p.id === value)) && <option value="">{none ?? 'Choose a property…'}</option>}
        {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
  );
}

function ViewMenu({ db, canDelete, onDelete }: { db: Db; canDelete: boolean; onDelete: () => void }) {
  const { view: v, schema, setView } = db;
  const phone = useIsPhone();
  const groupable = groupableProps(schema);
  const dates = schema.filter((p) => p.type === 'date');
  const numbers = schema.filter((p) => p.type === 'number');
  const chartable = schema.filter((p) => ['select', 'status', 'multi_select', 'checkbox', 'person', 'relation', 'date'].includes(p.type));
  const chart: ChartConfig = v.chart ?? { kind: 'bar', groupBy: chartable[0]?.id ?? 'createdAt', measure: 'count' };
  const setChart = (p: Partial<ChartConfig>) => setView({ chart: { ...chart, ...p } });
  const addDate = () => { const p: Property = { id: uid(), name: 'Date', type: 'date' }; db.setSchema([...schema, p]); setTimeout(() => setView({ dateProp: p.id }), 60); };
  const addStatus = () => { const p: Property = { id: uid(), name: 'Status', type: 'status', options: STATUS_OPTIONS() }; db.setSchema([...schema, p]); setTimeout(() => setView({ groupBy: p.id }), 60); };
  return (
    <div style={{ width: 290 }}>
      <div className="menu-pad">
        <input className="input small" aria-label="View name" defaultValue={v.name} onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== v.name) setView({ name: n }); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <div className="layout-grid" role="radiogroup" aria-label="Layout">
          {VIEW_TYPES.map((t) => { const I = VIEWS[t].icon; return (
            <button key={t} type="button" role="radio" aria-checked={v.type === t} className={v.type === t ? 'on' : ''} onClick={() => setView(defaultsFor(t, schema, v))}><I size={17} />{VIEWS[t].label}</button>
          ); })}
        </div>
        {v.type === 'board' && (groupable.length
          ? <PropSelect label="Group cards by" value={v.groupBy} onChange={(id) => setView({ groupBy: id, columnOrder: undefined, hiddenColumns: undefined })} props={groupable} />
          : <button className="btn small" onClick={addStatus}><Plus size={14} />Add a Status Property</button>)}
        {phone && ['table', 'list'].includes(v.type) && v.phone !== 'same' && groupable.length > 0 && (
          <PropSelect label="Group cards by" value={v.groupBy} onChange={(id) => setView({ groupBy: id, columnOrder: undefined, hiddenColumns: undefined })} props={groupable} none={groupable.some((p) => p.type === 'status') ? 'Status' : 'No grouping'} />
        )}
        {(v.type === 'calendar' || v.type === 'timeline') && (dates.length
          ? <PropSelect label={v.type === 'timeline' ? 'Starts on' : 'Show rows on'} value={v.dateProp} onChange={(id) => setView({ dateProp: id })} props={dates} />
          : <button className="btn small" onClick={addDate}><Plus size={14} />Add a Date Property</button>)}
        {v.type === 'timeline' && dates.length > 0 && (
          <>
            <PropSelect label="Ends on" value={v.endDateProp} onChange={(id) => setView({ endDateProp: id })} props={dates.filter((p) => p.id !== v.dateProp)} none="Same day" />
            <label className="field"><span>Zoom</span>
              <select className="select small" value={v.zoom ?? 'month'} onChange={(e) => setView({ zoom: e.target.value as View['zoom'] })}><option value="week">Weeks</option><option value="month">Months</option><option value="quarter">Quarters</option></select>
            </label>
          </>
        )}
        {v.type === 'gallery' && (
          <label className="field"><span>Card cover</span>
            <select className="select small" value={v.cover ?? 'page'} onChange={(e) => setView({ cover: e.target.value as View['cover'] })}><option value="page">First image on the page</option><option value="none">No cover</option></select>
          </label>
        )}
        {v.type === 'chart' && (
          <>
            <label className="field"><span>Chart type</span>
              <select className="select small" value={chart.kind} onChange={(e) => setChart({ kind: e.target.value as ChartConfig['kind'] })}><option value="bar">Bars</option><option value="donut">Donut</option><option value="line">Line</option></select>
            </label>
            <label className="field"><span>Group by</span>
              <select className="select small" value={chart.groupBy} onChange={(e) => setChart({ groupBy: e.target.value })}>
                {chartable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="createdAt">Month created</option>
              </select>
            </label>
            <label className="field"><span>Show</span>
              <select className="select small" value={chart.measure === 'count' ? 'count' : `${chart.measure}:${chart.valueProp ?? ''}`} onChange={(e) => {
                const [m, id] = e.target.value.split(':');
                setChart(m === 'count' ? { measure: 'count', valueProp: undefined } : { measure: m as 'sum' | 'avg', valueProp: id });
              }}>
                <option value="count">Number of rows</option>
                {numbers.map((p) => <option key={`s${p.id}`} value={`sum:${p.id}`}>Total of {p.name}</option>)}
                {numbers.map((p) => <option key={`a${p.id}`} value={`avg:${p.id}`}>Average of {p.name}</option>)}
              </select>
            </label>
          </>
        )}
        {!['gallery', 'chart', 'feed'].includes(v.type) && (
          <label className="field"><span><Smartphone size={12} style={{ verticalAlign: -1 }} /> On phones</span>
            <select className="select small" value={v.phone ?? 'auto'} onChange={(e) => setView({ phone: e.target.value as View['phone'] })}><option value="auto">Easy card list</option><option value="same">Same as on a computer</option></select>
          </label>
        )}
      </div>
      {canDelete && (<><div className="menu-sep" /><MenuItem danger icon={<Trash2 size={16} />} onClick={onDelete}>Delete View</MenuItem></>)}
    </div>
  );
}

/** A database view shown inside another screen (the home dashboard). Rows stay editable; layout options do not. */
export function EmbeddedDatabase({ databaseId, viewId, limit }: { databaseId: string; viewId?: string; limit?: number }) {
  const page = usePage(databaseId);
  if (page.isPending) return null;
  if (page.isError || !page.data || page.data.kind !== 'database') return <div className="empty">This database isn’t available any more.</div>;
  return <EmbeddedInner key={page.data.id} page={page.data} viewId={viewId} limit={limit} />;
}

function EmbeddedInner({ page, viewId, limit }: { page: Page; viewId?: string; limit?: number }) {
  const save: Save = (p) => { patch(`/api/pages/${page.id}`, p).then(() => qc.invalidateQueries({ queryKey: ['page', page.id] })).catch(() => {}); };
  const { db } = useDb(page, !!page.canEdit && !page.deletedAt, save);
  const view = db.views.find((v) => v.id === viewId) ?? db.views[0];
  const shown = useMemo(() => { const all = applyView(db.rows, view, db.schema); return limit ? all.slice(0, limit) : all; }, [db.rows, view, db.schema, limit]);
  return <ViewBody db={{ ...db, view, shown, setView: () => {}, setSchema: () => {} }} />;
}

export { PropIcon };

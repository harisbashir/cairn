import { ArrowDownUp, Check, EyeOff, ListFilter, Pencil, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import type { Filter, FilterOp, Property, PropertyType, Sort } from '../../../shared/types.ts';
import { uid } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { MenuItem, Popover, useUi } from '../ui.tsx';
import { cardProps, COLORS, hasOptions, PropIcon, TYPES, type Db } from './kit.tsx';
import { effectiveType, isComputed, NUMBER_FORMATS, resultKind } from '../db3/format.ts';
import { configLabel, newPropertyDraft, openPropConfig } from '../db3/PropConfig.tsx';

// ---------- Filter / sort / fields ----------
const OPS: Record<string, [FilterOp, string][]> = {
  text: [['contains', 'contains'], ['not_contains', 'doesn’t contain'], ['eq', 'is'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  select: [['eq', 'is'], ['neq', 'is not'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  multi: [['contains', 'contains'], ['not_contains', 'doesn’t contain'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  date: [['eq', 'is'], ['lt', 'is before'], ['gt', 'is after'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  checkbox: [['checked', 'is checked'], ['unchecked', 'is not checked']],
  files: [['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
};
const opGroup = (t: PropertyType | 'title') => (t === 'files' ? 'files' : t === 'title' || t === 'text' || t === 'url' ? 'text' : t === 'number' ? 'number' : t === 'select' || t === 'status' ? 'select' : t === 'date' ? 'date' : t === 'checkbox' ? 'checkbox' : 'multi');
const noValue = (op: FilterOp) => op === 'is_empty' || op === 'is_not_empty' || op === 'checked' || op === 'unchecked';

export function FilterMenu({ db }: { db: Db }) {
  const { view, schema, setView, canEdit } = db;
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="btn ghost small" {...p}><ListFilter size={15} /><span className="hide-phone">Filter</span>{view.filters.length > 0 && <span className="pill-count">{view.filters.length}</span>}</button>}>
      <div className="menu-pad" style={{ width: 430, maxWidth: '100%' }}>
        <FilterList filters={view.filters} schema={schema} canEdit={canEdit} onChange={(filters) => setView({ filters })} empty="Show only rows that match conditions." />
      </div>
    </Popover>
  );
}

/** The editable list of filter conditions, shared by views and rollups. */
export function FilterList({ filters, schema, canEdit, onChange, empty }: { filters: Filter[]; schema: Property[]; canEdit: boolean; onChange: (f: Filter[]) => void; empty: string }) {
  const fields: { id: string; name: string; type: PropertyType | 'title' }[] = [{ id: 'title', name: 'Name', type: 'title' }, ...schema.map((p) => ({ id: p.id, name: p.name, type: effectiveType(p) }))];
  const update = (i: number, p: Partial<Filter>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <>
        {filters.length === 0 && <span className="subtle">{empty}</span>}
        {filters.map((f, i) => {
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
              {noValue(f.op) ? <span className="grow" /> : prop && hasOptions(prop.type) && !isComputed(prop) ? (
                <select className="select small grow" aria-label="Value" disabled={!canEdit} value={String(f.value ?? '')} onChange={(e) => update(i, { value: e.target.value || undefined })}>
                  <option value="">Choose…</option>{prop.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <input className="input small grow" aria-label="Value" disabled={!canEdit} type={group === 'number' ? 'number' : group === 'date' ? 'date' : 'text'} value={String(f.value ?? '')}
                  onChange={(e) => update(i, { value: e.target.value === '' ? undefined : group === 'number' ? Number(e.target.value) : e.target.value })} />
              )}
              {canEdit && <button className="icon-btn" aria-label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))}><X size={15} /></button>}
            </div>
          );
        })}
        {canEdit && <button type="button" className="btn ghost small" style={{ justifySelf: 'start' }} onClick={() => onChange([...filters, { propertyId: 'title', op: 'contains' }])}><Plus size={15} />Add Filter</button>}
    </>
  );
}

export function SortMenu({ db }: { db: Db }) {
  const { view, schema, setView, canEdit } = db;
  const fields = [{ id: 'title', name: 'Name' }, ...schema.map((p) => ({ id: p.id, name: p.name })), { id: 'createdAt', name: 'Created' }, { id: 'updatedAt', name: 'Last edited' }];
  const update = (i: number, p: Partial<Sort>) => setView({ sorts: view.sorts.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="btn ghost small" {...p}><ArrowDownUp size={15} /><span className="hide-phone">Sort</span>{view.sorts.length > 0 && <span className="pill-count">{view.sorts.length}</span>}</button>}>
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

export function FieldsMenu({ db }: { db: Db }) {
  const { view, schema, setView } = db;
  if (!db.canEdit) return null;
  const table = view.type === 'table';
  const hidden = view.hidden ?? [];
  const onCards = cardProps(db).map((p) => p.id);
  const isOn = (id: string) => (table ? !hidden.includes(id) : onCards.includes(id));
  const toggle = (id: string) => {
    if (table) setView({ hidden: hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id] });
    else setView({ cardProps: onCards.includes(id) ? onCards.filter((x) => x !== id) : [...onCards, id] });
  };
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="btn ghost small" {...p}><SlidersHorizontal size={15} /><span className="hide-phone">Properties</span></button>}>
      <div className="menu-label">{table ? 'Columns in this view' : 'Shown on cards'}</div>
      {schema.map((p) => (
        <MenuItem key={p.id} keepOpen icon={<PropIcon type={p.type} />} hint={isOn(p.id) ? <Check size={15} /> : <EyeOff size={14} />} onClick={() => toggle(p.id)}>{p.name}</MenuItem>
      ))}
      {schema.length === 0 && <div className="menu-label" style={{ fontWeight: 400 }}>No properties yet.</div>}
    </Popover>
  );
}

// ---------- Property (column) menu ----------
export function PropertyMenu({ db, prop, close }: { db: Db; prop: Property; close: () => void }) {
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
          if (type === 'rollup' || type === 'formula') { close(); openPropConfig(db.page.id, { ...newPropertyDraft(type, db), id: prop.id, name: prop.name }, false); return; }
          update({ type, rollup: undefined, formula: undefined, options: hasOptions(type) ? (prop.options ?? (type === 'status' ? [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }] : [])) : undefined });
        }}>
          {TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        {prop.type === 'relation' && (
          <select className="select small" aria-label="Linked database" value={prop.relationDatabaseId ?? ''} onChange={(e) => update({ relationDatabaseId: e.target.value || undefined })}>
            <option value="">Link to database…</option>{dbs.map((d) => <option key={d.id} value={d.id}>{d.icon} {d.title || 'Untitled'}</option>)}
          </select>
        )}
        {isComputed(prop) && (
          <button type="button" className="btn small d3-cfg-btn" onClick={() => { close(); openPropConfig(db.page.id, prop, false); }}>
            <Pencil size={14} /><span className="grow">{configLabel(prop, db)}</span>
          </button>
        )}
        {(prop.type === 'number' || resultKind(prop) === 'number') && (
          <label className="field"><span>Number format</span>
            <select className="select small" value={prop.numberFormat ?? 'plain'} onChange={(e) => update({ numberFormat: e.target.value as Property['numberFormat'] })}>
              {NUMBER_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}{f.sample ? ` (${f.sample})` : ''}</option>)}
            </select>
          </label>
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

export function AddProperty({ db }: { db: Db }) {
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="th-btn" style={{ width: 44, justifyContent: 'center' }} aria-label="Add a property" title="Add a property" {...p}><Plus size={16} /></button>}>
      <div className="menu-label">New property</div>
      {TYPES.map((t) => (
        <MenuItem key={t.type} icon={<PropIcon type={t.type} />} onClick={() => (t.type === 'rollup' || t.type === 'formula') ? openPropConfig(db.page.id, newPropertyDraft(t.type, db), true) : db.setSchema([...db.schema, {
          id: uid(), name: t.label, type: t.type,
          options: t.type === 'status' ? [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }] : hasOptions(t.type) ? [] : undefined,
        }])}>{t.label}</MenuItem>
      ))}
    </Popover>
  );
}

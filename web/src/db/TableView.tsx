import { ArrowUpRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Row } from '../../../shared/types.ts';
import { Popover } from '../ui.tsx';
import { marksProp, PropIcon, PropValueEditor, type Db } from './kit.tsx';
import { RowMarks } from '../db3/Values.tsx';
import { AddProperty, PropertyMenu } from './menus.tsx';

export function TitleInput({ row, db }: { row: Row; db: Db }) {
  return (
    <input key={row.title} className="cell-input" defaultValue={row.title} placeholder="Untitled" aria-label="Name" readOnly={!db.canEdit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onBlur={(e) => { if (e.target.value !== row.title) db.patchRow(row.id, { title: e.target.value }); }} />
  );
}

export function TableView({ db }: { db: Db }) {
  const { view, schema, shown, canEdit } = db;
  const cols = schema.filter((p) => !(view.hidden ?? []).includes(p.id));
  const markId = (r: Row) => marksProp(schema, r);
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
                <Link className="open" to={db.rowHref(r.id)} aria-label={`Open ${r.title || 'Untitled'}`}><ArrowUpRight size={13} />Open</Link>
              </div></td>
              {cols.map((c) => (
                <td key={c.id}>
                  <PropValueEditor prop={c} value={r.props[c.id] ?? null} editable={canEdit} users={db.users} wid={db.wid}
                    marks={c.id === markId(r) ? <RowMarks row={r as never} /> : undefined}
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

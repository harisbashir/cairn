import { ArrowLeft, ArrowRight, EyeOff, Kanban, MoreHorizontal, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Property, SelectOption } from '../../../shared/types.ts';
import { uid } from '../api.ts';
import { MenuItem, Popover } from '../ui.tsx';
import { CardMeta, Chip, type Db } from './kit.tsx';

/** Board columns in the view's own order: option ids left to right, '' is the "no value" column. */
export function boardColumns(db: Pick<Db, 'view'>, group: Property): { id: string; opt: SelectOption | null }[] {
  const all = [...(group.options ?? []).map((o) => ({ id: o.id, opt: o as SelectOption | null })), { id: '', opt: null }];
  const order = db.view.columnOrder ?? [];
  const rank = (id: string) => { const i = order.indexOf(id); return i === -1 ? order.length + all.findIndex((c) => c.id === id) : i; };
  return all.sort((a, b) => rank(a.id) - rank(b.id)).filter((c) => !(db.view.hiddenColumns ?? []).includes(c.id));
}

export function BoardView({ db }: { db: Db }) {
  const { view, schema, shown, canEdit } = db;
  const group = schema.find((p) => p.id === view.groupBy && (p.type === 'select' || p.type === 'status'));
  const drag = useRef<{ kind: 'card' | 'col'; id: string } | null>(null);
  const [over, setOver] = useState<{ col: string; card?: string; side?: 'left' | 'right' } | null>(null);

  if (!group) {
    return (
      <div className="empty"><Kanban size={22} />A board groups rows by a Select or Status property.
        {canEdit && <button className="btn" onClick={() => {
          const p: Property = { id: uid(), name: 'Status', type: 'status', options: [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }] };
          db.setSchema([...schema, p]); setTimeout(() => db.setView({ groupBy: p.id }), 60);
        }}>Add a Status Property</button>}
      </div>
    );
  }
  const columns = boardColumns(db, group);
  const hidden = view.hiddenColumns ?? [];
  const ids = columns.map((c) => c.id);
  const moveColumn = (id: string, to: number) => {
    const next = ids.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
    db.setView({ columnOrder: next });
  };
  const end = () => { drag.current = null; setOver(null); };

  return (
    <div className="board" onDragEnd={end}>
      {columns.map((col, index) => {
        const rows = shown.filter((r) => String(r.props[group.id] ?? '') === col.id);
        if (!col.opt && rows.length === 0) return null;
        const name = col.opt?.name ?? `No ${group.name}`;
        const isOver = over?.col === col.id;
        return (
          <section
            key={col.id} aria-label={name}
            className={`col${isOver && drag.current?.kind === 'card' && !over?.card ? ' over' : ''}${isOver && over?.side ? ` drop-${over.side}` : ''}`}
            onDragOver={(e) => {
              const d = drag.current; if (!d) return;
              e.preventDefault();
              if (d.kind === 'col') {
                if (d.id === col.id) return setOver(null);
                const r = e.currentTarget.getBoundingClientRect();
                setOver({ col: col.id, side: e.clientX < r.left + r.width / 2 ? 'left' : 'right' });
              } else if (!(e.target as HTMLElement).closest('.kcard')) setOver({ col: col.id });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const d = drag.current; const o = over; end();
              if (!d) return;
              if (d.kind === 'col') {
                if (!o?.side || d.id === col.id) return;
                const without = ids.filter((x) => x !== d.id);
                moveColumn(d.id, without.indexOf(col.id) + (o.side === 'right' ? 1 : 0));
              } else {
                const moving = shown.find((r) => r.id === d.id);
                if (moving && String(moving.props[group.id] ?? '') !== col.id) db.patchRow(d.id, { props: { [group.id]: col.id || null } });
                if (o?.card && o.card !== d.id) db.moveRow(d.id, o.card);
              }
            }}
          >
            <header className="col-head" draggable={canEdit} onDragStart={(e) => { drag.current = { kind: 'col', id: col.id }; e.dataTransfer.effectAllowed = 'move'; }} title={canEdit ? 'Drag to move this column' : undefined}>
              {col.opt ? <Chip opt={col.opt} status={group.type === 'status'} /> : <span className="muted">{name}</span>}
              <span className="n">{rows.length}</span><span className="grow" />
              {canEdit && (
                <>
                  <Popover placement="bottom-end" trigger={(p) => <button className="icon-btn" aria-label={`Column options for ${name}`} {...p}><MoreHorizontal size={15} /></button>}>
                    <MenuItem icon={<ArrowLeft size={16} />} onClick={() => moveColumn(col.id, index - 1)}>Move Left</MenuItem>
                    <MenuItem icon={<ArrowRight size={16} />} onClick={() => moveColumn(col.id, index + 1)}>Move Right</MenuItem>
                    <MenuItem icon={<EyeOff size={16} />} onClick={() => db.setView({ hiddenColumns: [...hidden, col.id] })}>Hide Column</MenuItem>
                  </Popover>
                  <button className="icon-btn" aria-label={`Add to ${name}`} onClick={() => db.addRow({ [group.id]: col.id || null })}><Plus size={15} /></button>
                </>
              )}
            </header>
            <div className="col-cards">
              {rows.map((r) => (
                <Link
                  key={r.id} to={db.rowHref(r.id)} className={`kcard${over?.card === r.id ? ' drop-after' : ''}`} draggable={canEdit}
                  onDragStart={(e) => { e.stopPropagation(); drag.current = { kind: 'card', id: r.id }; e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { if (drag.current?.kind === 'card' && drag.current.id !== r.id) { e.preventDefault(); e.stopPropagation(); setOver({ col: col.id, card: r.id }); } }}
                >
                  <span className="t">{r.icon && <span className="emoji ico">{r.icon}</span>}{r.title || 'Untitled'}</span>
                  <CardMeta row={r} db={db} skip={group.id} />
                </Link>
              ))}
            </div>
            {canEdit && <button className="add-row col-add" onClick={() => db.addRow({ [group.id]: col.id || null })}><Plus size={15} />New</button>}
          </section>
        );
      })}
      {canEdit && hidden.length > 0 && (
        <div className="col ghost">
          <div className="col-head"><span className="muted">Hidden columns</span></div>
          {hidden.map((id) => {
            const opt = group.options?.find((o) => o.id === id);
            return <button key={id} className="add-row col-add" onClick={() => db.setView({ hiddenColumns: hidden.filter((h) => h !== id) })}>{opt ? <Chip opt={opt} status={group.type === 'status'} /> : `No ${group.name}`}<span className="grow" />Show</button>;
          })}
        </div>
      )}
    </div>
  );
}

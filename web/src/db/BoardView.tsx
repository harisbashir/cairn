import { ArrowLeft, ArrowRight, EyeOff, Kanban, MoreHorizontal, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Property } from '../../../shared/types.ts';
import { uid } from '../api.ts';
import { MenuItem, Popover } from '../ui.tsx';
import { CardMeta, Chip, type Db } from './kit.tsx';
import { allGroupLabel, canMoveBetween, groupableProps, groupsFor, inGroup, moveValue, newRowValue, type Group } from './groups.ts';

export function BoardView({ db }: { db: Db }) {
  const { view, schema, shown, canEdit } = db;
  const group = groupableProps(schema).find((p) => p.id === view.groupBy);
  const drag = useRef<{ kind: 'card' | 'col'; id: string; from?: string } | null>(null);
  const [over, setOver] = useState<{ col: string; card?: string; side?: 'left' | 'right' } | null>(null);

  if (!group) {
    return (
      <div className="empty"><Kanban size={22} />A board groups rows by one of their properties.
        {groupableProps(schema).length > 0 && (
          <select className="select small" aria-label="Group cards by" value="" onChange={(e) => e.target.value && db.setView({ groupBy: e.target.value, columnOrder: undefined, hiddenColumns: undefined })}>
            <option value="">Group cards by…</option>
            {groupableProps(schema).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {canEdit && <button className="btn" onClick={() => {
          const p: Property = { id: uid(), name: 'Status', type: 'status', options: [{ id: uid(), name: 'Not started', color: 'gray' }, { id: uid(), name: 'In progress', color: 'blue' }, { id: uid(), name: 'Done', color: 'green' }] };
          db.setSchema([...schema, p]); setTimeout(() => db.setView({ groupBy: p.id }), 60);
        }}>Add a Status Property</button>}
      </div>
    );
  }
  const columns = groupsFor(group, shown, view, db);
  const movable = canMoveBetween(group);
  const head = (g: Group) => g.opt ? <Chip opt={g.opt} status={group.type === 'status'} /> : g.color ? <span className={`marker ${g.color}`}>{g.label}</span> : <span className={g.id ? 'col-label' : 'muted'}>{g.label}</span>;
  const addTo = (id: string) => db.addRow({ [group.id]: newRowValue(group, id) });
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
        const rows = shown.filter((r) => inGroup(r, group, col.id));
        if (!col.opt && group.type !== 'checkbox' && rows.length === 0) return null;
        const name = col.label;
        const isOver = over?.col === col.id;
        return (
          <section
            key={col.id} aria-label={name}
            className={`col${isOver && drag.current?.kind === 'card' && !over?.card && (movable || drag.current.from === col.id) ? ' over' : ''}${isOver && over?.side ? ` drop-${over.side}` : ''}`}
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
                if (d.from !== col.id && !movable) return;
                if (moving && d.from !== undefined && !inGroup(moving, group, col.id)) db.patchRow(d.id, { props: { [group.id]: moveValue(moving, group, d.from, col.id) } });
                if (o?.card && o.card !== d.id) db.moveRow(d.id, o.card);
              }
            }}
          >
            <header className="col-head" draggable={canEdit} onDragStart={(e) => { drag.current = { kind: 'col', id: col.id }; e.dataTransfer.effectAllowed = 'move'; }} title={canEdit ? 'Drag to move this column' : undefined}>
              {head(col)}
              <span className="n">{rows.length}</span><span className="grow" />
              {canEdit && (
                <>
                  <Popover placement="bottom-end" trigger={(p) => <button className="icon-btn" aria-label={`Column options for ${name}`} {...p}><MoreHorizontal size={15} /></button>}>
                    <MenuItem icon={<ArrowLeft size={16} />} onClick={() => moveColumn(col.id, index - 1)}>Move Left</MenuItem>
                    <MenuItem icon={<ArrowRight size={16} />} onClick={() => moveColumn(col.id, index + 1)}>Move Right</MenuItem>
                    <MenuItem icon={<EyeOff size={16} />} onClick={() => db.setView({ hiddenColumns: [...hidden, col.id] })}>Hide Column</MenuItem>
                  </Popover>
                  <button className="icon-btn" aria-label={`Add to ${name}`} onClick={() => addTo(col.id)}><Plus size={15} /></button>
                </>
              )}
            </header>
            <div className="col-cards">
              {rows.map((r) => (
                <Link
                  key={r.id} to={db.rowHref(r.id)} title={r.title || 'Untitled'} className={`kcard${over?.card === r.id ? ' drop-after' : ''}`} draggable={canEdit}
                  onDragStart={(e) => { e.stopPropagation(); drag.current = { kind: 'card', id: r.id, from: col.id }; e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { if (drag.current?.kind === 'card' && drag.current.id !== r.id) { e.preventDefault(); e.stopPropagation(); setOver({ col: col.id, card: r.id }); } }}
                >
                  <span className="t">{r.icon && <span className="emoji ico">{r.icon}</span>}{r.title || 'Untitled'}</span>
                  <CardMeta row={r} db={db} skip={group.id} />
                </Link>
              ))}
            </div>
            {canEdit && <button className="add-row col-add" onClick={() => addTo(col.id)}><Plus size={15} />New</button>}
          </section>
        );
      })}
      {canEdit && hidden.length > 0 && (
        <div className="col ghost">
          <div className="col-head"><span className="muted">Hidden columns</span></div>
          {hidden.map((id) => {
            const opt = group.options?.find((o) => o.id === id);
            return <button key={id} className="add-row col-add" onClick={() => db.setView({ hiddenColumns: hidden.filter((h) => h !== id) })}>{opt ? <Chip opt={opt} status={group.type === 'status'} /> : <span className="clip">{allGroupLabel(group, id, db)}</span>}<span className="grow" />Show</button>;
          })}
        </div>
      )}
    </div>
  );
}

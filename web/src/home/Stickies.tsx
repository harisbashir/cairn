import { ArrowLeft, ArrowRight, Check, Lock, MoreHorizontal, Plus, StickyNote, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import type { Sticky, StickyColor } from '../../../shared/types.ts';
import { timeAgo } from '../api.ts';
import { AiTag } from '../Home.tsx';
import { useShell } from '../Shell.tsx';
import { MenuItem, Popover, Switch, useUi } from '../ui.tsx';
import { createSticky, deleteSticky, moveStickyLocally, refetchStickies, updateSticky, useStickies } from './hooks.ts';
import { LoadError, WidgetMessage } from './widgets/kit.tsx';

const COLORS: { id: StickyColor; name: string }[] = [
  { id: 'yellow', name: 'Yellow' }, { id: 'orange', name: 'Orange' }, { id: 'pink', name: 'Pink' }, { id: 'purple', name: 'Purple' },
  { id: 'blue', name: 'Blue' }, { id: 'green', name: 'Green' }, { id: 'gray', name: 'Gray' },
];
const SAVE_AFTER_MS = 800;

/** Shared between the heading button and the wall so a new note can be focused once it renders. */
let focusNext: string | null = null;

export function AddNoteButton() {
  const s = useShell();
  const ui = useUi();
  const stickies = useStickies(s.wid);
  if (!s.canEdit || stickies.isError) return null;
  const add = async () => {
    try {
      const note = await createSticky(s.wid, { color: 'yellow' });
      focusNext = note.id;
      refetchStickies(s.wid);
    } catch (err) { ui.toast((err as Error).message); }
  };
  return <button type="button" className="btn small" onClick={add}><Plus size={14} />Add Note</button>;
}

export function StickiesWidget() {
  const s = useShell();
  const ui = useUi();
  const stickies = useStickies(s.wid);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);

  if (stickies.isError) return <LoadError what="Sticky notes" />;
  if (!stickies.data) return null;
  const notes = stickies.data;
  if (notes.length === 0) {
    return (
      <WidgetMessage>
        <StickyNote size={18} aria-hidden />
        {s.canEdit ? 'No notes yet. Select Add Note to jot something down for yourself or the team.' : 'No notes yet.'}
      </WidgetMessage>
    );
  }

  const move = (id: string, afterId: string | null) => {
    moveStickyLocally(s.wid, id, afterId);
    updateSticky(s.wid, id, { afterId }).catch((err: Error) => { ui.toast(err.message); refetchStickies(s.wid); });
  };
  const moveBy = (id: string, delta: -1 | 1) => {
    const rest = notes.filter((n) => n.id !== id);
    const at = notes.findIndex((n) => n.id === id) + delta;
    if (at < 0 || at > rest.length) return;
    move(id, at === 0 ? null : rest[at - 1].id);
  };
  const onDrop = () => {
    if (dragId && drop && dragId !== drop.id) {
      const rest = notes.filter((n) => n.id !== dragId);
      const target = rest.findIndex((n) => n.id === drop.id);
      const at = drop.before ? target : target + 1;
      move(dragId, at === 0 ? null : rest[at - 1].id);
    }
    setDragId(null);
    setDrop(null);
  };
  const remove = async (note: Sticky) => {
    const index = notes.findIndex((n) => n.id === note.id);
    const prevId = index > 0 ? notes[index - 1].id : null;
    try {
      await deleteSticky(s.wid, note.id);
      ui.toast('Note deleted', async () => {
        try {
          const back = await createSticky(s.wid, { text: note.text, color: note.color, visibility: note.visibility });
          if (prevId) {
            moveStickyLocally(s.wid, back.id, prevId);
            await updateSticky(s.wid, back.id, { afterId: prevId });
          }
        } catch (err) { ui.toast((err as Error).message); refetchStickies(s.wid); }
      });
    } catch (err) { ui.toast((err as Error).message); refetchStickies(s.wid); }
  };

  return (
    <ul className="hm-wall" aria-label="Sticky notes">
      {notes.map((n, i) => (
        <Note
          key={n.id} note={n} first={i === 0} last={i === notes.length - 1}
          dragging={dragId === n.id} dropSide={drop?.id === n.id && dragId !== n.id ? (drop.before ? 'before' : 'after') : null}
          onDragStart={() => setDragId(n.id)}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setDrop({ id: n.id, before: e.clientX < r.left + r.width / 2 });
          }}
          onDrop={(e) => { e.preventDefault(); onDrop(); }}
          onDragEnd={() => { setDragId(null); setDrop(null); }}
          onMove={(delta) => moveBy(n.id, delta)}
          onDelete={() => remove(n)}
        />
      ))}
    </ul>
  );
}

function Note({ note, first, last, dragging, dropSide, onDragStart, onDragOver, onDrop, onDragEnd, onMove, onDelete }: {
  note: Sticky;
  first: boolean;
  last: boolean;
  dragging: boolean;
  dropSide: 'before' | 'after' | null;
  onDragStart: () => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
  onDrop: (e: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const s = useShell();
  const ui = useUi();
  const [text, setText] = useState(note.text);
  const saved = useRef(note.text);
  const timer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  const li = useRef<HTMLLIElement>(null);
  const mine = note.createdBy === s.user.id;
  const editable = s.canEdit;

  // Take in changes from others unless this note is being typed in.
  useEffect(() => {
    if (document.activeElement !== area.current) { setText(note.text); saved.current = note.text; }
  }, [note.text]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (focusNext === note.id) { focusNext = null; area.current?.focus(); }
  });

  const save = (value: string) => {
    window.clearTimeout(timer.current);
    if (value === saved.current) return;
    saved.current = value;
    updateSticky(s.wid, note.id, { text: value }).catch((err: Error) => ui.toast(err.message));
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const set = (body: { color?: StickyColor; visibility?: Sticky['visibility'] }) =>
    updateSticky(s.wid, note.id, body).catch((err: Error) => { ui.toast(err.message); refetchStickies(s.wid); });

  const author = note.createdByName || 'Someone';
  return (
    <li
      ref={li}
      className={`hm-sticky${dragging ? ' dragging' : ''}${dropSide ? ` drop-${dropSide}` : ''}`}
      style={{ background: `var(--o-${note.color}-bg)`, color: `var(--o-${note.color}-fg)` }}
      onDragOver={onDragOver} onDrop={onDrop}
    >
      {editable && (
        <span
          className="hm-tape" draggable title="Drag to reorder" aria-hidden
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', note.text);
            if (li.current) e.dataTransfer.setDragImage(li.current, 90, 12);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
        />
      )}
      {editable ? (
        <textarea
          ref={area} className="hm-sticky-text" value={text} maxLength={2000} rows={3} placeholder="Write something…"
          aria-label={`Note by ${author}`}
          onChange={(e) => {
            setText(e.target.value);
            window.clearTimeout(timer.current);
            const value = e.target.value;
            timer.current = window.setTimeout(() => save(value), SAVE_AFTER_MS);
          }}
          onBlur={() => save(text)}
        />
      ) : (
        <div className="hm-sticky-text" aria-label={`Note by ${author}`}>{note.text}</div>
      )}
      <div className="hm-sticky-foot">
        <span className="hm-initial" title={author} aria-hidden>{author.trim().slice(0, 1).toUpperCase()}</span>
        <span className="grow hm-ellipsis" title={`${author}, ${new Date(note.updatedAt).toLocaleString()}`}>
          <span className="hm-sr">{author}, </span>{timeAgo(note.updatedAt)}
        </span>
        {note.createdByType === 'ai' && <AiTag />}
        {note.visibility === 'private' && <span className="hm-private" title="Private: only you can see this note"><Lock size={13} aria-hidden /><span className="hm-sr">Private</span></span>}
        {editable && (
          <Popover
            placement="bottom-end"
            trigger={(props) => (
              <button type="button" className="icon-btn hm-sticky-menu" aria-label={`Options for note by ${author}`} title="Note options" {...props}>
                <MoreHorizontal size={15} />
              </button>
            )}
          >
            <div className="menu-label">Colour</div>
            <div className="hm-swatches" role="radiogroup" aria-label="Note colour">
              {COLORS.map((c) => (
                <button
                  key={c.id} type="button" role="radio" aria-checked={note.color === c.id} aria-label={c.name} title={c.name}
                  className="hm-swatch" style={{ background: `var(--o-${c.id}-bg)`, color: `var(--o-${c.id}-fg)` }}
                  onClick={() => set({ color: c.id })}
                >
                  {note.color === c.id && <Check size={14} aria-hidden />}
                </button>
              ))}
            </div>
            <div className="menu-sep" />
            {mine ? (
              <label className="menu-item hm-switch-item">
                <Lock size={16} />
                <span className="grow">Only Me</span>
                <Switch on={note.visibility === 'private'} label="Only I can see this note"
                  onChange={(on) => set({ visibility: on ? 'private' : 'workspace' })} />
              </label>
            ) : (
              <div className="menu-label hm-wrap">Only {author} can make this note private.</div>
            )}
            <div className="menu-sep" />
            {!first && <MenuItem icon={<ArrowLeft size={16} />} onClick={() => onMove(-1)}>Move Earlier</MenuItem>}
            {!last && <MenuItem icon={<ArrowRight size={16} />} onClick={() => onMove(1)}>Move Later</MenuItem>}
            <MenuItem icon={<Trash2 size={16} />} danger onClick={onDelete}>Delete Note</MenuItem>
          </Popover>
        )}
      </div>
    </li>
  );
}

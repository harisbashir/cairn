import { ArrowLeft, ArrowRight, Check, Lock, MoreHorizontal, Plus, StickyNote, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Sticky, StickyColor } from '../../../shared/types.ts';
import { timeAgo } from '../api.ts';
import { AiTag } from '../Home.tsx';
import { useShell } from '../Shell.tsx';
import { MenuItem, Modal, Popover, Switch, useUi } from '../ui.tsx';
import { createSticky, deleteSticky, moveStickyLocally, refetchStickies, updateSticky, useStickies } from './hooks.ts';
import { LoadError, WidgetMessage } from './widgets/kit.tsx';
import { afterIdFor, useReorder } from './reorder.ts';

const COLORS: { id: StickyColor; name: string }[] = [
  { id: 'yellow', name: 'Yellow' }, { id: 'orange', name: 'Orange' }, { id: 'pink', name: 'Pink' }, { id: 'purple', name: 'Purple' },
  { id: 'blue', name: 'Blue' }, { id: 'green', name: 'Green' }, { id: 'gray', name: 'Gray' },
];
const SAVE_AFTER_MS = 800;

/** Shared between the heading button and the wall so a new note opens for writing once it renders. */
let openNext: string | null = null;

export function AddNoteButton() {
  const s = useShell();
  const ui = useUi();
  const stickies = useStickies(s.wid);
  if (!s.canEdit || stickies.isError) return null;
  const add = async () => {
    try {
      const note = await createSticky(s.wid, { color: 'yellow' });
      openNext = note.id;
      refetchStickies(s.wid);
    } catch (err) { ui.toast((err as Error).message); }
  };
  return <button type="button" className="btn small" onClick={add}><Plus size={14} />Add Note</button>;
}

export function StickiesWidget() {
  const s = useShell();
  const ui = useUi();
  const stickies = useStickies(s.wid);
  const [openId, setOpenId] = useState<string | null>(null);
  const notes = stickies.data ?? [];
  const move = (id: string, afterId: string | null) => {
    moveStickyLocally(s.wid, id, afterId);
    updateSticky(s.wid, id, { afterId }).catch((err: Error) => { ui.toast(err.message); refetchStickies(s.wid); });
  };
  const reorder = useReorder({
    mode: 'press',
    ids: notes.map((n) => n.id),
    element: (id) => document.getElementById(`hm-sticky-${id}`),
    onDrop: (dragId, t) => move(dragId, afterIdFor(notes.map((n) => n.id), dragId, t)),
  });
  useEffect(() => {
    if (openNext && notes.some((n) => n.id === openNext)) { setOpenId(openNext); openNext = null; }
  });

  if (stickies.isError) return <LoadError what="Sticky notes" />;
  if (!stickies.data) return null;
  if (notes.length === 0) {
    return (
      <WidgetMessage>
        <StickyNote size={18} aria-hidden />
        {s.canEdit ? 'No notes yet. Select Add Note to jot something down for yourself or the team.' : 'No notes yet.'}
      </WidgetMessage>
    );
  }

  const moveBy = (id: string, delta: -1 | 1) => {
    const rest = notes.filter((n) => n.id !== id);
    const at = notes.findIndex((n) => n.id === id) + delta;
    if (at < 0 || at > rest.length) return;
    move(id, at === 0 ? null : rest[at - 1].id);
  };
  const remove = async (note: Sticky) => {
    const index = notes.findIndex((n) => n.id === note.id);
    const prevId = index > 0 ? notes[index - 1].id : null;
    setOpenId(null);
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
  const open = notes.find((n) => n.id === openId);
  const openIndex = open ? notes.indexOf(open) : -1;

  return (
    <>
      <ul className="hm-wall" aria-label="Sticky notes">
        {notes.map((n) => (
          <NoteCard
            key={n.id} note={n}
            dragging={reorder.dragId === n.id}
            dropSide={reorder.drop?.id === n.id && reorder.dragId !== n.id ? (reorder.drop.before ? 'before' : 'after') : null}
            onPointerDown={s.canEdit ? reorder.bind(n.id).onPointerDown : undefined}
            onOpen={() => { if (!reorder.wasDrag()) setOpenId(n.id); }}
          />
        ))}
      </ul>
      {open && (
        <NoteEditor
          key={open.id} note={open} first={openIndex === 0} last={openIndex === notes.length - 1}
          onMove={(delta) => moveBy(open.id, delta)} onDelete={() => remove(open)} onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

/** A short first line reads as the note's title, the way Notes does it; a note that is one long paragraph has none. */
function split(text: string) {
  const t = text.replace(/^\s+/, '');
  const i = t.indexOf('\n');
  const first = i < 0 ? t : t.slice(0, i);
  if (first.length > 60 || (i < 0 && t.length > 60)) return { title: '', rest: t, label: first.slice(0, 60) };
  return { title: first, rest: i < 0 ? '' : t.slice(i + 1).replace(/^\s+/, ''), label: first };
}

function NoteCard({ note, dragging, dropSide, onPointerDown, onOpen }: {
  note: Sticky;
  dragging: boolean;
  dropSide: 'before' | 'after' | null;
  onPointerDown?: (e: RPointerEvent) => void;
  onOpen: () => void;
}) {
  const textRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [note.text]);
  const author = note.createdByName || 'Someone';
  const { title, rest, label } = split(note.text);
  return (
    <li
      id={`hm-sticky-${note.id}`}
      className={`hm-sticky${dragging ? ' dragging' : ''}${dropSide ? ` drop-${dropSide}` : ''}`}
      style={{ background: `var(--o-${note.color}-bg)`, color: `var(--o-${note.color}-fg)` }}
      onPointerDown={onPointerDown}
    >
      <button type="button" className="hm-sticky-open" onClick={onOpen} aria-label={`Open note by ${author}: ${label || 'empty'}`} />
      <div ref={textRef} className={`hm-sticky-text${clipped ? ' clipped' : ''}`} aria-hidden>
        {title && <b>{title}</b>}
        {!title && !rest && <span className="hm-sticky-empty">Empty note</span>}
        {rest && <span>{rest}</span>}
      </div>
      <div className="hm-sticky-foot" aria-hidden>
        <span className="hm-initial" title={author}>{author.trim().slice(0, 1).toUpperCase()}</span>
        <span className="grow hm-ellipsis" title={`${author}, ${new Date(note.updatedAt).toLocaleString()}`}>{timeAgo(note.updatedAt)}</span>
        {note.createdByType === 'ai' && <AiTag />}
        {note.visibility === 'private' && <span className="hm-private" title="Private: only you can see this note"><Lock size={13} /></span>}
      </div>
    </li>
  );
}

function NoteEditor({ note, first, last, onMove, onDelete, onClose }: {
  note: Sticky;
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const s = useShell();
  const ui = useUi();
  const [text, setText] = useState(note.text);
  const saved = useRef(note.text);
  const timer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  const mine = note.createdBy === s.user.id;
  const editable = s.canEdit;
  const author = note.createdByName || 'Someone';

  // Take in changes from others unless this note is being typed in.
  useEffect(() => {
    if (document.activeElement !== area.current) { setText(note.text); saved.current = note.text; }
  }, [note.text]);
  // A new note opens ready to type. An existing one opens to read on touch screens, so the keyboard doesn't cover it.
  const [typeNow] = useState(() => !note.text || !matchMedia('(pointer: coarse)').matches);
  const caretSet = useRef(false);

  const save = (value: string) => {
    window.clearTimeout(timer.current);
    if (value === saved.current) return;
    saved.current = value;
    updateSticky(s.wid, note.id, { text: value }).catch((err: Error) => ui.toast(err.message));
  };
  const latest = useRef(text);
  latest.current = text;
  // Whatever way the sheet closes, the last keystrokes are saved.
  useEffect(() => () => { window.clearTimeout(timer.current); if (editable) save(latest.current); }, []);

  const set = (body: { color?: StickyColor; visibility?: Sticky['visibility'] }) =>
    updateSticky(s.wid, note.id, body).catch((err: Error) => { ui.toast(err.message); refetchStickies(s.wid); });

  return (
    <Modal onClose={onClose} label={`Note by ${author}`} className="modal hm-note-sheet" focusDialog={!typeNow}>
      <div className="hm-note-head">
          <span className="hm-initial" aria-hidden>{author.trim().slice(0, 1).toUpperCase()}</span>
          <span className="grow hm-ellipsis"><b>{author}</b> · {timeAgo(note.updatedAt)}</span>
          {note.createdByType === 'ai' && <AiTag />}
          {note.visibility === 'private' && <span className="hm-private" title="Private: only you can see this note"><Lock size={14} aria-hidden /><span className="hm-sr">Private</span></span>}
          {editable && (
            <Popover
              placement="bottom-end"
              trigger={(props) => (
                <button type="button" className="icon-btn hm-sticky-menu" aria-label="Note options" title="Note options" {...props}>
                  <MoreHorizontal size={18} />
                </button>
              )}
            >
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
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
      </div>
      <div className="hm-note-paper" style={{ background: `var(--o-${note.color}-bg)`, color: `var(--o-${note.color}-fg)` }}>
        {editable ? (
          <textarea
            ref={area} className="hm-note-area" value={text} maxLength={2000} placeholder="Write something…"
            aria-label={`Note by ${author}`}
            data-autofocus={typeNow ? '' : undefined}
            onFocus={(e) => { if (caretSet.current) return; caretSet.current = true; const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }}
            onChange={(e) => {
              setText(e.target.value);
              window.clearTimeout(timer.current);
              const value = e.target.value;
              timer.current = window.setTimeout(() => save(value), SAVE_AFTER_MS);
            }}
            onBlur={() => save(text)}
          />
        ) : (
          <div className="hm-note-area" tabIndex={0}>{note.text}</div>
        )}
      </div>
      {editable && (
        <div className="hm-note-bar">
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
        </div>
      )}
    </Modal>
  );
}

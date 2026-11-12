import { ArrowDown, ArrowUp, ChevronRight, GripVertical, LayoutDashboard, MoreHorizontal, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { Component, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Widget } from '../../../shared/types.ts';
import { uid } from '../api.ts';
import { TopBar } from '../Home.tsx';
import { useShell } from '../Shell.tsx';
import { MenuItem, Modal, Popover, useUi } from '../ui.tsx';
import './home.css';
import { resetHome, saveHome, useHome, type HomeScope } from './hooks.ts';
import { DEFAULT_WIDGETS, headingOf, KIND, WIDGETS } from './registry.tsx';
import type { WidgetConfig } from './types.ts';

const SIZES: { id: Widget['size']; label: string }[] = [
  { id: 'third', label: 'Third' }, { id: 'half', label: 'Half' }, { id: 'two-thirds', label: 'Two-thirds' }, { id: 'full', label: 'Full' },
];

type DropSide = 'left' | 'right' | 'top' | 'bottom';

export function Home() {
  const s = useShell();
  const ui = useUi();
  const home = useHome(s.wid);
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const [scope, setScope] = useState<HomeScope>('personal');
  const [gallery, setGallery] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; side: DropSide } | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const layout = home.data;
  const editing = draft !== null;
  const stored = layout?.widgets ?? (home.isError ? DEFAULT_WIDGETS : null);
  const widgets = (draft ?? stored ?? []).filter((w) => KIND.has(w.type));

  const start = () => { setDraft(structuredClone(stored ?? DEFAULT_WIDGETS)); setScope('personal'); };
  const update = (id: string, fn: (w: Widget) => Widget) => setDraft((d) => d && d.map((w) => (w.id === id ? fn(w) : w)));
  const move = (id: string, delta: -1 | 1) => setDraft((d) => {
    if (!d) return d;
    const i = d.findIndex((w) => w.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= d.length) return d;
    const next = [...d];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const add = (type: Widget['type']) => {
    const kind = KIND.get(type)!;
    const w: Widget = { id: uid(), type, size: kind.size, config: structuredClone(kind.config) };
    setDraft((d) => [...(d ?? []), w]);
    setGallery(false);
    requestAnimationFrame(() => {
      const el = document.getElementById(`hm-w-${w.id}`);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      el?.querySelector<HTMLInputElement>('.hm-w-title')?.focus({ preventScroll: true });
    });
  };
  const done = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await saveHome(s.wid, scope, draft);
      setDraft(null);
      ui.toast(scope === 'workspace' ? 'Home saved for everyone in this workspace' : 'Home saved for you');
    } catch (err) {
      ui.toast(`Couldn’t save Home: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    const ok = await ui.confirm({
      title: 'Reset Home to the workspace default?',
      body: 'Your own layout is removed and you’ll see the Home everyone in this workspace shares. Sticky notes are kept.',
      action: 'Reset Home',
    });
    if (!ok) return;
    try {
      await resetHome(s.wid);
      setDraft(null);
      ui.toast('Home reset to the workspace default');
    } catch (err) {
      ui.toast(`Couldn’t reset Home: ${(err as Error).message}`);
    }
  };
  const onDragOver = (e: DragEvent<HTMLElement>, id: string) => {
    if (!dragId) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const fullRow = r.width > (grid.current?.clientWidth ?? 0) * 0.9;
    const side: DropSide = fullRow
      ? (e.clientY < r.top + r.height / 2 ? 'top' : 'bottom')
      : (e.clientX < r.left + r.width / 2 ? 'left' : 'right');
    if (drop?.id !== id || drop.side !== side) setDrop({ id, side });
  };
  const onDrop = () => {
    if (dragId && drop && dragId !== drop.id) {
      setDraft((d) => {
        if (!d) return d;
        const moving = d.find((w) => w.id === dragId);
        if (!moving) return d;
        const rest = d.filter((w) => w.id !== dragId);
        const at = rest.findIndex((w) => w.id === drop.id) + (drop.side === 'left' || drop.side === 'top' ? 0 : 1);
        return [...rest.slice(0, at), moving, ...rest.slice(at)];
      });
    }
    setDragId(null);
    setDrop(null);
  };

  return (
    <>
      <TopBar here="Home">
        {!editing && stored && (
          <button type="button" className="btn small" onClick={start}><LayoutDashboard size={14} />Customize</button>
        )}
      </TopBar>
      <div className="content">
        <div className={`hm-dash${editing ? ' editing' : ''}`}>
          {stored && widgets.length === 0 && (
            <div className="hm-msg hm-blank">
              {editing ? 'Your Home is empty. Select Add Widget to put something on it.' : 'Your Home is empty. Select Customize to add widgets.'}
            </div>
          )}
          <div className="hm-grid" ref={grid}>
            {widgets.map((w, i) => (
              <WidgetFrame
                key={w.id} widget={w} editing={editing} first={i === 0} last={i === widgets.length - 1}
                dragging={dragId === w.id} dropSide={drop?.id === w.id && dragId !== w.id ? drop.side : null}
                onChange={(config) => update(w.id, (x) => ({ ...x, config }))}
                onRename={(title) => update(w.id, (x) => ({ ...x, title }))}
                onResize={(size) => update(w.id, (x) => ({ ...x, size }))}
                onMove={(delta) => move(w.id, delta)}
                onRemove={() => setDraft((d) => d && d.filter((x) => x.id !== w.id))}
                onDragStart={() => setDragId(w.id)}
                onDragEnd={() => { setDragId(null); setDrop(null); }}
                onDragOver={(e) => onDragOver(e, w.id)}
                onDrop={(e) => { e.preventDefault(); onDrop(); }}
              />
            ))}
          </div>
        </div>
        {editing && (
          <div className="hm-bar" role="region" aria-label="Customize Home">
            <button type="button" className="btn" onClick={() => setGallery(true)}><Plus size={16} />Add Widget</button>
            <fieldset className="hm-scope">
              <legend className="hm-sr">Who sees this layout</legend>
              <label><input type="radio" name="hm-scope" checked={scope === 'personal'} onChange={() => setScope('personal')} />Just for me</label>
              {layout?.canEditShared && (
                <label><input type="radio" name="hm-scope" checked={scope === 'workspace'} onChange={() => setScope('workspace')} />For everyone in this workspace</label>
              )}
            </fieldset>
            {layout?.personal && (
              <button type="button" className="btn ghost small" onClick={reset}><RotateCcw size={14} />Reset to Workspace Default</button>
            )}
            {scope === 'workspace' && layout?.personal && (
              <span className="subtle hm-bar-note">You’ll keep seeing your own layout until you reset it.</span>
            )}
            <span className="grow" />
            <div className="hm-bar-actions">
              <button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn primary" onClick={done} disabled={saving}>{saving ? 'Saving…' : 'Done'}</button>
            </div>
          </div>
        )}
      </div>
      {gallery && <Gallery onPick={add} onClose={() => setGallery(false)} />}
    </>
  );
}

function WidgetFrame({
  widget, editing, first, last, dragging, dropSide, onChange, onRename, onResize, onMove, onRemove, onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  widget: Widget;
  editing: boolean;
  first: boolean;
  last: boolean;
  dragging: boolean;
  dropSide: DropSide | null;
  onChange: (config: WidgetConfig) => void;
  onRename: (title: string) => void;
  onResize: (size: Widget['size']) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}) {
  const s = useShell();
  const section = useRef<HTMLElement>(null);
  const kind = KIND.get(widget.type)!;
  const heading = headingOf(widget, s.tree?.nodes ?? []);
  const targetId = kind.target?.(widget);
  const { Component: Body, Action } = kind;
  const cls = ['hm-w', `hm-${widget.size}`, `hm-type-${widget.type}`, dragging && 'dragging', dropSide && `drop-${dropSide}`].filter(Boolean).join(' ');

  return (
    <section
      ref={section} id={`hm-w-${widget.id}`} className={cls} aria-label={heading}
      onDragOver={editing ? onDragOver : undefined} onDrop={editing ? onDrop : undefined}
    >
      {editing ? (
        <div className="hm-w-bar">
          <span
            className="hm-grip" draggable title="Drag to reorder" aria-hidden
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', heading);
              if (section.current) e.dataTransfer.setDragImage(section.current, 24, 20);
              onDragStart();
            }}
            onDragEnd={onDragEnd}
          >
            <GripVertical size={16} />
          </span>
          <kind.icon size={15} className="hm-w-icon" aria-hidden />
          <input
            className="input small hm-w-title" value={widget.title ?? ''} placeholder={headingOf({ ...widget, title: '' }, s.tree?.nodes ?? [])}
            aria-label={`Title of the ${kind.name} widget`} maxLength={80}
            onChange={(e) => onRename(e.target.value)}
          />
          <select className="select small hm-w-size" aria-label="Width" value={widget.size} onChange={(e) => onResize(e.target.value as Widget['size'])}>
            {SIZES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
          </select>
          <Popover
            placement="bottom-end"
            trigger={(props) => (
              <button type="button" className="icon-btn" aria-label={`More options for ${heading}`} title="More options" {...props}><MoreHorizontal size={16} /></button>
            )}
          >
            {!first && <MenuItem icon={<ArrowUp size={16} />} onClick={() => onMove(-1)}>Move Up</MenuItem>}
            {!last && <MenuItem icon={<ArrowDown size={16} />} onClick={() => onMove(1)}>Move Down</MenuItem>}
            {!(first && last) && <div className="menu-sep" />}
            <MenuItem icon={<Trash2 size={16} />} danger onClick={onRemove}>Remove Widget</MenuItem>
          </Popover>
        </div>
      ) : widget.type !== 'welcome' && (
        <div className="hm-w-h">
          <h2>
            {targetId
              ? <Link to={`/w/${s.wid}/p/${targetId}`}>{heading}<ChevronRight size={14} aria-hidden /></Link>
              : heading}
          </h2>
          {Action && <Action />}
        </div>
      )}
      <div className="hm-w-body">
        <Boundary key={`${widget.type}:${editing}`}>
          <Body widget={widget} editing={editing} onChange={onChange} />
        </Boundary>
      </div>
    </section>
  );
}

/** Keeps one broken widget from taking the whole Home down. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="hm-msg">This widget ran into a problem. Reload the page to try again.</div> : this.props.children;
  }
}

function Gallery({ onPick, onClose }: { onPick: (type: Widget['type']) => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose} label="Add Widget" className="modal hm-gallery">
      <div className="row">
        <h2 className="grow">Add Widget</h2>
        <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="hm-gallery-grid">
        {WIDGETS.map((k) => (
          <button key={k.type} type="button" className="hm-gallery-item" onClick={() => onPick(k.type)}>
            <span className="hm-gallery-ico" aria-hidden><k.icon size={18} /></span>
            <span className="grow">
              <b>{k.name.charAt(0).toUpperCase() + k.name.slice(1)}</b>
              <span>{k.description}</span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

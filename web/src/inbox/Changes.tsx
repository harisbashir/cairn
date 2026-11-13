import { Bot, ChevronRight, ListChecks, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChangeDetail, ChangeSummary } from '../../../shared/types.ts';
import { timeAgo } from '../api.ts';
import { AiTag, TopBar } from '../Home.tsx';
import { PageIcon, useShell } from '../Shell.tsx';
import { Avatar, useUi } from '../ui.tsx';
import { refreshAfterUndo, undoChange, undoMany, useChangeDetail, useChanges, type ActorFilter } from './hooks.ts';
import './inbox.css';

const VERB: Record<ChangeSummary['action'], string> = {
  created: 'created', updated: 'edited', deleted: 'moved to Trash', restored: 'restored', moved: 'moved', shared: 'shared',
  joined: 'joined', repeated: 'repeated', undone: 'undid a change on',
};

// Bookkeeping fields every new page records; they say nothing to a person reviewing the change.
const SETUP_FIELDS = new Set(['Icon', 'Cover', 'Properties', 'Views', 'Location', 'Visibility', 'Reminders', 'Template']);

/** The field labels worth showing in the one-line summary. */
export function changeFields(c: ChangeSummary) {
  if (c.action !== 'updated') return [];
  return c.fields;
}

/** Markdown from the server escapes punctuation ("small\."); show it as written. */
const unescapeMd = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

function meaningfulDiffs(d: ChangeDetail) {
  return d.diffs.filter((x) => {
    if (x.before === x.after) return false;
    if ((d.action === 'created' || d.action === 'deleted') && SETUP_FIELDS.has(x.field)) return false;
    return true;
  });
}

export function actorLabel(c: ChangeSummary) {
  return c.actorType === 'ai' ? (c.clientName || c.actorName || 'AI agent') : (c.actorName || 'Someone');
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

// ---------- Line diff ----------
type Line = { kind: 'same' | 'add' | 'del'; text: string };
function lineDiff(a: string, b: string): Line[] {
  const x = a ? a.split('\n') : [];
  const y = b ? b.split('\n') : [];
  // Plain LCS; page bodies are small enough. Very large ones fall back to before/after blocks.
  if (x.length * y.length > 250_000) return [...x.map((text) => ({ kind: 'del' as const, text })), ...y.map((text) => ({ kind: 'add' as const, text }))];
  const n = x.length, m = y.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: Line[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: 'del', text: x[i++] });
    else out.push({ kind: 'add', text: y[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] });
  while (j < m) out.push({ kind: 'add', text: y[j++] });
  // Blank lines between unchanged paragraphs are noise.
  return out.filter((l, k) => !(l.kind === 'same' && !l.text.trim() && (out[k - 1]?.kind === 'same' || k === 0)));
}

function ContentDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(unescapeMd(before), unescapeMd(after));
  return (
    <div className="inb-linediff" role="table" aria-label="Content changes">
      {lines.map((l, k) => (
        <div key={k} role="row" className={`inb-ln ${l.kind}`}>
          <span className="inb-ln-mark" aria-label={l.kind === 'add' ? 'Added' : l.kind === 'del' ? 'Removed' : undefined}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
          <span className="inb-ln-text">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function Diffs({ id }: { id: string }) {
  const detail = useChangeDetail(id, true);
  if (detail.isPending) return <div className="inb-quiet">Loading…</div>;
  if (detail.isError) return <div className="inb-quiet">The details can’t load right now. {detail.error.message}</div>;
  const diffs = meaningfulDiffs(detail.data);
  if (!diffs.length) return <div className="inb-quiet">No details were recorded for this change.</div>;
  return (
    <div className="inb-diffs">
      {detail.data.conflict && !detail.data.undoneAt && <div className="inb-warn">This page changed again since. Undoing overwrites the newer edits to these fields.</div>}
      {diffs.map((d, k) => (
        <div key={k} className="inb-diff">
          <div className="inb-diff-field">{d.field}</div>
          {d.field === 'Content' ? <ContentDiff before={d.before} after={d.after} /> : (
            <div className="inb-diff-vals">
              <span className={`inb-before${d.before ? '' : ' is-empty'}`}>{d.before ? unescapeMd(d.before) : 'Empty'}</span>
              <span className="inb-arrow" aria-label="changed to">→</span>
              <span className={`inb-after${d.after ? '' : ' is-empty'}`}>{d.after ? unescapeMd(d.after) : 'Empty'}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Undo with the "changed since" question. Returns true when it was undone. */
export function useUndo() {
  const s = useShell();
  const ui = useUi();
  return async (c: ChangeSummary) => {
    try {
      let r = await undoChange(c.id);
      if (r === 'conflict') {
        const ok = await ui.confirm({
          title: 'This page changed since. Undo anyway?',
          body: `Undoing puts back what was there before ${actorLabel(c)}’s change and overwrites the newer edits to the same fields.`,
          action: 'Undo Anyway', danger: true,
        });
        if (!ok) return false;
        r = await undoChange(c.id, true);
      }
      refreshAfterUndo(s.wid);
      ui.toast(`Undone: ${c.pageTitle || 'Untitled'}`);
      return r === 'ok';
    } catch (err) {
      ui.toast((err as Error).message);
      return false;
    }
  };
}

export function ChangeLine({ c, compact }: { c: ChangeSummary; compact?: boolean }) {
  const s = useShell();
  const fields = changeFields(c);
  return (
    <>
      <span className="inb-change-who">
        <b>{actorLabel(c)}</b>{c.actorType === 'ai' && <AiTag />}
      </span>{' '}
      <span className="inb-change-verb">{VERB[c.action] ?? c.action}</span>{' '}
      <Link to={`/w/${s.wid}/p/${c.pageId}`} className="inb-change-page">
        <PageIcon icon={c.pageIcon} kind={c.pageKind} size={13} /><span>{c.pageTitle || 'Untitled'}</span>
      </Link>
      {c.databaseTitle && <span className="inb-change-db"> in {c.databaseTitle}</span>}
      {!compact && fields.length > 0 && <div className="inb-change-fields">{fields.map((f) => <span key={f} className="inb-field">{f}</span>)}</div>}
    </>
  );
}

function ChangeItem({ c, selecting, selected, onSelect, canEdit }: {
  c: ChangeSummary; selecting: boolean; selected: boolean; onSelect: (on: boolean) => void; canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const undo = useUndo();
  const done = !!c.undoneAt;
  const undoable = canEdit && c.canUndo && !done && c.action !== 'undone';
  return (
    <li className={`inb-change${done ? ' undone' : ''}${open ? ' open' : ''}${selected ? ' selected' : ''}`}>
      <div className="inb-change-row">
        {selecting && (
          <input type="checkbox" className="inb-check" checked={selected} disabled={!undoable} onChange={(e) => onSelect(e.target.checked)}
            aria-label={`Select change to ${c.pageTitle || 'Untitled'}`} />
        )}
        <span className="inb-change-av" aria-hidden>{c.actorType === 'ai' ? <span className="inb-bot"><Bot size={15} /></span> : <Avatar name={c.actorName} color="#868e96" />}</span>
        <div className="inb-change-main">
          <div className="inb-change-text"><ChangeLine c={c} /></div>
          <div className="inb-change-meta">
            <span title={new Date(c.at).toLocaleString()}>{timeAgo(c.at)}</span>
            {done && <span className="inb-undone">Undone{c.undoneByName ? ` by ${c.undoneByName}` : ''}</span>}
          </div>
        </div>
        <div className="inb-change-acts">
          {undoable && !selecting && (
            <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); await undo(c); setBusy(false); }}>
              <Undo2 size={14} />Undo
            </button>
          )}
          {c.action !== 'undone' && (
            <button className={`icon-btn inb-expand${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(!open)}>
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
      {open && <Diffs id={c.id} />}
    </li>
  );
}

/** Route /w/:wid/changes: what AI agents (or anyone) changed, with undo. */
export function ChangesScreen() {
  const s = useShell();
  const ui = useUi();
  const [actor, setActor] = useState<ActorFilter>('ai');
  const [client, setClient] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const changes = useChanges(s.wid, actor, client);
  const items = useMemo(() => changes.data?.pages.flat() ?? [], [changes.data]);

  // The client chips stay put while one is picked, so remember every name seen.
  const seen = useRef(new Set<string>());
  for (const c of items) if (c.clientName && (actor === 'ai' ? c.actorType === 'ai' : true)) seen.current.add(c.clientName);
  const clients = [...seen.current].sort((a, b) => a.localeCompare(b));
  useEffect(() => { setSelected(new Set()); }, [actor, client]);

  const groups = useMemo(() => {
    const out: { day: string; items: ChangeSummary[] }[] = [];
    for (const c of items) {
      const day = dayLabel(c.at);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(c);
    }
    return out;
  }, [items]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && changes.hasNextPage && !changes.isFetchingNextPage) changes.fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [changes]);

  const undoSelected = async () => {
    const ids = items.filter((c) => selected.has(c.id)).map((c) => c.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      let r = await undoMany(ids);
      let undone = r.undone.length;
      if (r.conflicts.length) {
        const ok = await ui.confirm({
          title: r.conflicts.length === 1 ? 'A page changed since. Undo anyway?' : `${r.conflicts.length} pages changed since. Undo anyway?`,
          body: 'Undoing those overwrites the newer edits to the same fields.', action: 'Undo Anyway', danger: true,
        });
        if (ok) { const f = await undoMany(r.conflicts, true); undone += f.undone.length; r = { ...r, failed: [...r.failed, ...f.failed] }; }
      }
      refreshAfterUndo(s.wid);
      ui.toast(`${undone} ${undone === 1 ? 'change' : 'changes'} undone${r.failed.length ? `, ${r.failed.length} couldn’t be undone` : ''}`);
      setSelected(new Set());
      setSelecting(false);
    } catch (err) { ui.toast((err as Error).message); }
    setBusy(false);
  };

  const selectable = items.filter((c) => c.canUndo && !c.undoneAt && c.action !== 'undone');
  return (
    <>
      <TopBar back={s.phone} here={<><Bot size={15} />AI changes</>} />
      <div className="content">
        <div className="inb-changes">
          <h1>AI changes</h1>
          <p className="lead">{actor === 'ai' ? 'What AI agents changed through MCP. Open a change to see it, and undo anything that went wrong.' : 'Every recorded change in this workspace, newest first.'}</p>
          <div className="inb-filters">
            <div className="inb-seg" role="radiogroup" aria-label="Who made the change">
              <button role="radio" aria-checked={actor === 'ai'} className={actor === 'ai' ? 'on' : ''} onClick={() => setActor('ai')}>AI agents</button>
              <button role="radio" aria-checked={actor === 'all'} className={actor === 'all' ? 'on' : ''} onClick={() => { setActor('all'); }}>Everyone</button>
            </div>
            {clients.length > 0 && (
              <div className="inb-chips" role="group" aria-label="Agent">
                <button className={`inb-chip${client ? '' : ' on'}`} aria-pressed={!client} onClick={() => setClient('')}>All</button>
                {clients.map((n) => <button key={n} className={`inb-chip${client === n ? ' on' : ''}`} aria-pressed={client === n} onClick={() => setClient(client === n ? '' : n)}>{n}</button>)}
              </div>
            )}
            {s.canEdit && selectable.length > 0 && (
              <button className="btn ghost small inb-select" onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
                {selecting ? <><X size={14} />Cancel</> : <><ListChecks size={15} />Select</>}
              </button>
            )}
          </div>

          {changes.isPending && <div className="inb-quiet">Loading…</div>}
          {changes.isError && <div className="inb-quiet">Changes can’t load right now. {changes.error.message}</div>}
          {changes.data && items.length === 0 && (
            <div className="inb-empty big">
              <Bot size={26} aria-hidden />
              <b>{actor === 'ai' ? 'No AI changes yet' : 'No changes yet'}</b>
              <span>{actor === 'ai' ? 'When Claude, Codex or another agent edits pages through MCP, every change shows up here and can be undone.' : 'Edits show up here as people and agents make them.'}</span>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.day} className="inb-day">
              <h2 className="inb-day-h">{g.day}</h2>
              <ul className="inb-change-list">
                {g.items.map((c) => (
                  <ChangeItem
                    key={c.id} c={c} selecting={selecting} selected={selected.has(c.id)} canEdit={s.canEdit}
                    onSelect={(on) => setSelected((old) => { const n = new Set(old); if (on) n.add(c.id); else n.delete(c.id); return n; })}
                  />
                ))}
              </ul>
            </section>
          ))}
          <div ref={sentinel} />
          {changes.isFetchingNextPage && <div className="inb-quiet">Loading more…</div>}
          {changes.data && items.length > 0 && !changes.hasNextPage && <div className="inb-end">Changes are kept for 90 days.</div>}
        </div>
      </div>
      {selecting && (
        <div className="inb-selbar" role="region" aria-label="Selection">
          <span className="grow">{selected.size ? `${selected.size} selected` : 'Select changes to undo'}</span>
          {selected.size < selectable.length && <button className="btn ghost small" onClick={() => setSelected(new Set(selectable.map((c) => c.id)))}>Select All</button>}
          <button className="btn primary small" disabled={!selected.size || busy} onClick={undoSelected}><Undo2 size={14} />Undo Selected</button>
        </div>
      )}
    </>
  );
}

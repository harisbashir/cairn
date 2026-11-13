import { Check, ChevronDown, FileText, Link2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { CaptureTarget, Page, WorkspaceSummary } from '../../../shared/types.ts';
import { patch, post, qc, useBootstrap, useTree } from '../api.ts';
import { Popover, useUi, WsBadge } from '../ui.tsx';
import './inbox.css';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;

/** Shared text often carries the link inside it ("Look at this https://…"). Pull it out into its own field. */
export function splitShared(title: string, text: string, url: string) {
  let t = text.trim();
  let u = url.trim();
  if (!u) {
    const m = URL_RE.exec(t) ?? URL_RE.exec(title);
    if (m) {
      u = m[0].replace(/[).,;:!?]+$/, '');
      t = t.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
    }
  } else if (t === u) t = '';
  let ti = title.trim();
  if (u && ti.includes(u)) ti = ti.replace(u, '').trim();
  return { title: ti, text: t, url: u };
}

function DestLabel({ target, workspaces }: { target: CaptureTarget | null; workspaces: WorkspaceSummary[] }) {
  const ws = workspaces.find((w) => w.id === target?.workspaceId);
  const tree = useTree(ws?.id ?? '');
  if (!ws || !target) return <span className="inb-dest-empty">Choose where to save</span>;
  const db = target.databaseId ? tree.data?.nodes.find((n) => n.id === target.databaseId) : null;
  return (
    <>
      <WsBadge name={ws.name} icon={ws.icon} color={ws.color} />
      <span className="grow inb-ell">
        <b>{target.databaseId ? (db ? `${db.icon ? `${db.icon} ` : ''}${db.title || 'Untitled'}` : '…') : 'New page'}</b>
        <span className="inb-dest-ws">{ws.name}</span>
      </span>
    </>
  );
}

function WorkspaceTargets({ ws, target, pick }: { ws: WorkspaceSummary; target: CaptureTarget | null; pick: (t: CaptureTarget) => void }) {
  const tree = useTree(ws.id);
  const dbs = (tree.data?.nodes ?? []).filter((n) => n.kind === 'database').sort((a, b) => a.title.localeCompare(b.title));
  const on = (db: string | null) => target?.workspaceId === ws.id && target.databaseId === db;
  const canWrite = ws.role !== 'viewer';
  if (!canWrite) return null;
  return (
    <div className="inb-dest-group" role="group" aria-label={ws.name}>
      <div className="inb-dest-h"><WsBadge name={ws.name} icon={ws.icon} color={ws.color} />{ws.name}</div>
      <button type="button" className={`menu-item${on(null) ? ' active' : ''}`} onClick={() => pick({ workspaceId: ws.id, databaseId: null })}>
        <FileText size={16} /><span className="grow">New page</span>{on(null) && <Check size={15} />}
      </button>
      {dbs.map((d) => (
        <button key={d.id} type="button" className={`menu-item${on(d.id) ? ' active' : ''}`} onClick={() => pick({ workspaceId: ws.id, databaseId: d.id })}>
          <span className="page-ico emoji" aria-hidden>{d.icon || '▦'}</span><span className="grow inb-ell">{d.title || 'Untitled'}</span>{on(d.id) && <Check size={15} />}
        </button>
      ))}
      {tree.isPending && <div className="inb-quiet">Loading…</div>}
    </div>
  );
}

/** Route /capture: the share-sheet and "New task" entry point. Saves a page or row in one step. */
export function CapturePage() {
  const boot = useBootstrap();
  const ui = useUi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const user = boot.data!.user!;
  const workspaces = boot.data!.workspaces;
  const initial = useMemo(() => splitShared(params.get('title') ?? '', params.get('text') ?? '', params.get('url') ?? ''), [params]);
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(initial.text);
  const [url, setUrl] = useState(initial.url);
  const fallback = useMemo<CaptureTarget | null>(() => {
    const saved = user.prefs.capture;
    if (saved && workspaces.some((w) => w.id === saved.workspaceId && w.role !== 'viewer')) return saved;
    const last = workspaces.find((w) => w.id === localStorage.getItem('cairn.ws') && w.role !== 'viewer') ?? workspaces.find((w) => w.role !== 'viewer');
    return last ? { workspaceId: last.id, databaseId: null } : null;
  }, [user.prefs.capture, workspaces]);
  const [target, setTarget] = useState<CaptureTarget | null>(fallback);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { document.title = 'Quick capture · Cairn'; }, []);
  useEffect(() => {
    // A share already has content: focus the title only when starting from scratch ("New task").
    if (!initial.title && !initial.text && !initial.url) titleRef.current?.focus();
  }, [initial]);

  const leave = () => {
    if (window.history.length > 1 && document.referrer.startsWith(location.origin)) navigate(-1);
    else navigate(target ? `/w/${target.workspaceId}` : '/', { replace: true });
  };

  const empty = !title.trim() && !text.trim() && !url.trim();
  const save = async () => {
    if (!target || empty || busy) return;
    setBusy(true);
    try {
      const r = await post<{ page: Page }>('/api/capture', {
        ...(title.trim() ? { title: title.trim() } : {}), ...(text.trim() ? { text: text.trim() } : {}), ...(url.trim() ? { url: url.trim() } : {}),
        workspaceId: target.workspaceId, databaseId: target.databaseId,
      });
      const saved = user.prefs.capture;
      if (saved?.workspaceId !== target.workspaceId || saved?.databaseId !== target.databaseId) {
        patch('/api/me', { prefs: { capture: target } }).then(() => qc.invalidateQueries({ queryKey: ['bootstrap'] })).catch(() => {});
      }
      qc.invalidateQueries({ queryKey: ['tree', target.workspaceId] });
      if (target.databaseId) qc.invalidateQueries({ queryKey: ['rows', target.databaseId] });
      const db = target.databaseId ? r.page.breadcrumbs?.at(-1)?.title : undefined;
      ui.toast(target.databaseId ? `Added to ${db || 'the database'}` : 'Page saved');
      navigate(`/w/${r.page.workspaceId}/p/${r.page.id}`, { replace: true });
    } catch (err) {
      ui.toast((err as Error).message);
      setBusy(false);
    }
  };

  const writable = workspaces.filter((w) => w.role !== 'viewer');
  return (
    <div className="inb-capture-wrap">
      <form className="inb-capture" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label="Quick capture">
        <header className="inb-capture-head">
          <button type="button" className="btn ghost" onClick={leave}>Cancel</button>
          <h1>Quick capture</h1>
          <button type="submit" className="btn primary" disabled={!target || empty || busy}>{busy ? 'Saving…' : 'Save'}</button>
        </header>

        <div className="inb-capture-body">
          <input
            ref={titleRef} className="inb-capture-title" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={url ? 'Title (optional)' : 'Title'} aria-label="Title" enterKeyHint="next" maxLength={500}
          />
          <textarea className="inb-capture-note" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note…" aria-label="Note" rows={4} />
          {url ? (
            <div className="inb-capture-url">
              <Link2 size={15} aria-hidden />
              <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link" inputMode="url" />
              <button type="button" className="icon-btn" aria-label="Remove link" onClick={() => setUrl('')}><X size={14} /></button>
            </div>
          ) : (
            <button type="button" className="inb-capture-addurl" onClick={() => setUrl('https://')}><Link2 size={15} />Add a link</button>
          )}
        </div>

        <div className="inb-capture-dest">
          <span className="inb-dest-label" id="inb-dest-l">Save to</span>
          {writable.length === 0 ? (
            <span className="inb-quiet">You can’t edit any workspace.</span>
          ) : (
            <Popover placement="top-start" className="menu inb-dest-menu" trigger={(p, open) => (
              <button type="button" className={`inb-dest${open ? ' open' : ''}`} aria-labelledby="inb-dest-l" {...p}>
                <DestLabel target={target} workspaces={workspaces} /><ChevronDown size={16} />
              </button>
            )}>
              {(close) => writable.map((w) => <WorkspaceTargets key={w.id} ws={w} target={target} pick={(t) => { setTarget(t); close(); }} />)}
            </Popover>
          )}
        </div>
        <p className="inb-capture-hint">Cairn remembers where you saved last.</p>
      </form>
    </div>
  );
}

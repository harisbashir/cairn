import {
  ChevronRight, ChevronsUpDown, Copy, FilePlus2, FileText, Home as HomeIcon, Lock, LogOut, MoreHorizontal, PanelLeft, Plus,
  Search, Settings as SettingsIcon, Star, StarOff, Table2, Trash2, UserPlus, Users, Check, Sparkles,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { Bootstrap, LiveEvent, Page, PageKind, SearchHit, Tree, TreeNode, User, Visibility, WorkspaceSummary } from '../../shared/types.ts';
import { clientId, MOD, del, invalidateWorkspace, patch, post, put, qc, searchPages, useTree } from './api.ts';
import { SettingsModal, type SettingsSection } from './Settings.tsx';
import { applyPrefs } from './theme.ts';
import { Avatar, MenuItem, Modal, Popover, useIsPhone, useUi, WsBadge, WS_COLORS } from './ui.tsx';

interface ShellCtx {
  wid: string;
  workspace: WorkspaceSummary;
  user: User;
  boot: Bootstrap;
  canEdit: boolean;
  tree: Tree | undefined;
  createPage: (opts: { parentId?: string | null; kind?: PageKind; visibility?: Visibility; title?: string }) => Promise<Page | null>;
  trashPage: (id: string, title: string) => Promise<void>;
  toggleFavorite: (id: string, on: boolean) => Promise<void>;
  openSettings: (section?: SettingsSection) => void;
  openPalette: () => void;
  toggleSidebar: () => void;
  collapsed: boolean;
  phone: boolean;
  signOut: () => void;
}
const Ctx = createContext<ShellCtx>(null!);
export const useShell = () => useContext(Ctx);

export function PageIcon({ icon, kind, size = 15 }: { icon: string; kind: PageKind | 'page' | 'database'; size?: number }) {
  return (
    <span className="page-ico emoji" aria-hidden>
      {icon || (kind === 'database' ? <Table2 size={size} /> : <FileText size={size} />)}
    </span>
  );
}

/** Paths seen at each history index in this tab, so a Back button can tell whether popping history lands somewhere sensible. */
export const visitedPaths = new Map<number, string>();
function useTrackHistory() {
  const { pathname } = useLocation();
  const idx: number = window.history.state?.idx ?? 0;
  useEffect(() => { visitedPaths.set(idx, pathname); }, [idx, pathname]);
}

export function Shell({ boot }: { boot: Bootstrap }) {
  useTrackHistory();
  const { wid = '', pid } = useParams();
  const navigate = useNavigate();
  const ui = useUi();
  const workspace = boot.workspaces.find((w) => w.id === wid);
  const phone = useIsPhone();
  const [collapsed, setCollapsed] = useState(false);
  const prefsKey = JSON.stringify(boot.user?.prefs ?? {});
  useEffect(() => { applyPrefs(JSON.parse(prefsKey)); }, [prefsKey]);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [palette, setPalette] = useState(false);
  const [newWs, setNewWs] = useState(false);
  const tree = useTree(workspace ? wid : '');

  useEffect(() => { if (workspace) localStorage.setItem('cairn.ws', wid); }, [wid, workspace]);

  // Live updates from other people, other tabs and AI agents.
  useEffect(() => {
    if (!workspace) return;
    const es = new EventSource(`/api/workspaces/${wid}/events`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as LiveEvent;
      if (ev.type === 'ping') return;
      if (ev.type === 'members') { qc.invalidateQueries({ queryKey: ['members', wid] }); qc.invalidateQueries({ queryKey: ['bootstrap'] }); return; }
      if (ev.type === 'home' || ev.type === 'stickies') {
        // Dashboard and sticky-note queries keep their own keys; refresh any whose key mentions them.
        const word = ev.type === 'home' ? 'home' : 'stick';
        qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).toLowerCase().includes(word) });
        return;
      }
      if (ev.type !== 'page' || ev.clientId === clientId) return;
      invalidateWorkspace(wid);
      qc.invalidateQueries({ queryKey: ['page', ev.pageId] });
      if (ev.parentId) qc.invalidateQueries({ queryKey: ['rows', ev.parentId] });
      window.dispatchEvent(new CustomEvent('cairn:remote', { detail: ev }));
    };
    return () => es.close();
  }, [wid, workspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); }
      if (mod && e.key === '\\') { e.preventDefault(); setCollapsed((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const canEdit = !!workspace && workspace.role !== 'viewer';

  const createPage = useCallback<ShellCtx['createPage']>(async (opts) => {
    try {
      const page = await post<Page>(`/api/workspaces/${wid}/pages`, { kind: 'page', title: '', ...opts });
      invalidateWorkspace(wid);
      if (page.kind === 'row') qc.invalidateQueries({ queryKey: ['rows', page.parentId] });
      else navigate(`/w/${wid}/p/${page.id}`);
      return page;
    } catch (err) { ui.toast((err as Error).message); return null; }
  }, [wid, navigate, ui]);

  const trashPage = useCallback(async (id: string, title: string) => {
    try {
      await del(`/api/pages/${id}`);
      invalidateWorkspace(wid);
      qc.invalidateQueries({ queryKey: ['rows'] });
      if (pid === id) navigate(`/w/${wid}`);
      ui.toast(`Moved “${title || 'Untitled'}” to Trash`, async () => {
        await post(`/api/pages/${id}/restore`);
        invalidateWorkspace(wid);
        qc.invalidateQueries({ queryKey: ['rows'] });
      });
    } catch (err) { ui.toast((err as Error).message); }
  }, [wid, pid, navigate, ui]);

  const toggleFavorite = useCallback(async (id: string, on: boolean) => {
    await (on ? put(`/api/pages/${id}/favorite`) : del(`/api/pages/${id}/favorite`));
    qc.invalidateQueries({ queryKey: ['tree', wid] });
    qc.invalidateQueries({ queryKey: ['page', id] });
  }, [wid]);

  if (!workspace) return <NoWorkspace boot={boot} />;

  const ctx: ShellCtx = {
    wid, workspace, user: boot.user!, boot, canEdit, tree: tree.data, createPage, trashPage, toggleFavorite,
    openSettings: (s = 'account') => setSettings(s), openPalette: () => setPalette(true),
    toggleSidebar: () => setCollapsed((v) => !v), collapsed: collapsed && !phone, phone,
    signOut: async () => { await post('/api/auth/logout'); location.href = '/'; },
  };

  return (
    <Ctx.Provider value={ctx}>
      <div className={`shell${collapsed && !phone ? ' collapsed' : ''}${phone ? ' phone' : ''}`}>
        {!phone && <Sidebar onNewWorkspace={() => setNewWs(true)} />}
        <main className="main"><Outlet context={{ onNewWorkspace: () => setNewWs(true) }} /></main>
        {phone && <TabBar />}
      </div>
      {palette && <Palette onClose={() => setPalette(false)} />}
      {settings && <SettingsModal section={settings} onSection={setSettings} onClose={() => setSettings(null)} />}
      {newWs && <NewWorkspace onClose={() => setNewWs(false)} />}
    </Ctx.Provider>
  );
}

function NoWorkspace({ boot }: { boot: Bootstrap }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="auth"><div className="auth-card">
      <img src="/logo.svg" alt="" />
      <h1>{boot.workspaces.length ? 'That workspace isn’t available' : 'Create your first workspace'}</h1>
      <p className="muted">A workspace holds pages and databases for you or your team.</p>
      {boot.workspaces.map((w) => <Link key={w.id} className="btn large" to={`/w/${w.id}`}>Open {w.name}</Link>)}
      <button className="btn primary large" onClick={() => setOpen(true)}>New Workspace</button>
      <button className="btn ghost" onClick={async () => { await post('/api/auth/logout'); location.href = '/'; }}>Sign Out</button>
      {open && <NewWorkspace onClose={() => setOpen(false)} />}
    </div></div>
  );
}

function NewWorkspace({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(WS_COLORS[0]);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  return (
    <Modal onClose={onClose} label="New workspace">
      <h2>New Workspace</h2>
      <form
        style={{ display: 'grid', gap: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const ws = await post<WorkspaceSummary>('/api/workspaces', { name: name.trim(), color });
            await qc.invalidateQueries({ queryKey: ['bootstrap'] });
            onClose();
            navigate(`/w/${ws.id}`, { replace: true }); // replaces the dialog's Back marker
          } catch (err) { setError((err as Error).message); }
        }}
      >
        <label className="field"><span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme, Family, Side project…" required autoFocus />
        </label>
        <div className="field"><span>Colour</span>
          <div className="color-dots" style={{ padding: 0 }}>
            {WS_COLORS.map((c) => <button key={c} type="button" aria-label={`Colour ${c}`} className={c === color ? 'on' : ''} style={{ background: c, width: 24, height: 24 }} onClick={() => setColor(c)} />)}
          </div>
        </div>
        {error && <p className="err">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>Create Workspace</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Sidebar ----------
/** The page tree: favourites, shared pages, private pages and Trash. Used by the sidebar and the phone's Pages tab. */
export function PageTree() {
  const s = useShell();
  const { pid } = useParams();
  const nodes = s.tree?.nodes ?? [];
  const byParent = useMemo(() => {
    const m = new Map<string | null, TreeNode[]>();
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      const key = n.parentId && ids.has(n.parentId) ? n.parentId : null;
      (m.get(key) ?? m.set(key, []).get(key)!).push(n);
    }
    for (const list of m.values()) list.sort((a, b) => a.position - b.position);
    return m;
  }, [nodes]);
  const roots = byParent.get(null) ?? [];
  const shared = roots.filter((n) => n.visibility !== 'private');
  const priv = roots.filter((n) => n.visibility === 'private');
  const favs = (s.tree?.favorites ?? []).map((id) => nodes.find((n) => n.id === id)).filter(Boolean) as TreeNode[];

  const [open, setOpen] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('cairn.open') ?? '{}'));
  const toggle = useCallback((id: string, v?: boolean) => setOpen((o) => {
    const next = { ...o, [id]: v ?? !o[id] };
    localStorage.setItem('cairn.open', JSON.stringify(next));
    return next;
  }), []);
  // Reveal the current page in the tree.
  useEffect(() => {
    if (!pid) return;
    let cur = nodes.find((n) => n.id === pid)?.parentId;
    while (cur) { if (!open[cur]) toggle(cur, true); cur = nodes.find((n) => n.id === cur)?.parentId ?? null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, nodes.length]);

  const section = (label: string, list: TreeNode[], visibility: Visibility, emptyText: string) => (
    <>
      <div className="side-head">
        <span>{label}</span>
        {s.canEdit && <NewMenu visibility={visibility} parentId={null} label={`New in ${label}`} />}
      </div>
      {list.length === 0 && <div className="tree-empty" style={{ paddingLeft: 8 }}>{emptyText}</div>}
      {list.map((n) => <TreeItem key={n.id} node={n} depth={0} byParent={byParent} open={open} toggle={toggle} />)}
    </>
  );
  return (
    <>
      {favs.length > 0 && (
        <>
          <div className="side-head"><span>Favorites</span></div>
          {favs.map((n) => (
            <div key={n.id} className={`tree-row${pid === n.id ? ' active' : ''}`} style={{ paddingLeft: 8 }}>
              <Link to={`/w/${s.wid}/p/${n.id}`}><PageIcon icon={n.icon} kind={n.kind} /><span className="t">{n.title || 'Untitled'}</span></Link>
            </div>
          ))}
        </>
      )}
      {section('Workspace', shared, 'workspace', 'No pages yet.')}
      {section('Private', priv, 'private', 'Only you can see pages here.')}
      <div className="side-head" />
      <NavLink to={`/w/${s.wid}/trash`} className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}><Trash2 size={16} />Trash</NavLink>
    </>
  );
}

function Sidebar({ onNewWorkspace }: { onNewWorkspace: () => void }) {
  const s = useShell();
  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="side-top">
        <div className="row" style={{ gap: 2 }}>
          <WorkspaceSwitcher onNew={onNewWorkspace} />
          <button className="icon-btn" aria-label="Hide sidebar" title={`Hide sidebar (${MOD}\\)`} onClick={s.toggleSidebar}><PanelLeft size={17} /></button>
        </div>
        <button className="side-search" onClick={s.openPalette}>
          <Search size={15} /><span className="grow">Search or jump to…</span><kbd>{MOD}K</kbd>
        </button>
        <NavLink end to={`/w/${s.wid}`} className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}><HomeIcon size={16} />Home</NavLink>
      </div>
      <div className="side-scroll"><PageTree /></div>
      <div className="side-bottom">
        <Popover placement="top-start" trigger={(p) => (
          <button className="user-btn" {...p}><Avatar name={s.user.name} color={s.user.color} /><span className="grow">{s.user.name}</span></button>
        )}>
          <div className="menu-label">{s.user.email}</div>
          <MenuItem icon={<SettingsIcon size={16} />} onClick={() => s.openSettings('account')}>Settings</MenuItem>
          <MenuItem icon={<Sparkles size={16} />} onClick={() => s.openSettings('ai')}>Connect AI (MCP)</MenuItem>
          <div className="menu-sep" />
          <MenuItem icon={<LogOut size={16} />} onClick={s.signOut}>Sign Out</MenuItem>
        </Popover>
        {(s.workspace.role === 'owner' || s.workspace.role === 'admin') && (
          <button className="icon-btn" aria-label="Invite people" title="Invite people" onClick={() => s.openSettings('members')}><UserPlus size={16} /></button>
        )}
      </div>
    </nav>
  );
}

// ---------- Phone navigation ----------
function TabBar() {
  const s = useShell();
  const tab = (to: string, end: boolean, icon: React.ReactNode, label: string) => (
    <NavLink to={to} end={end} className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>{icon}<span>{label}</span></NavLink>
  );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab(`/w/${s.wid}`, true, <HomeIcon size={22} />, 'Home')}
      {tab(`/w/${s.wid}/browse`, false, <FileText size={22} />, 'Pages')}
      {s.canEdit ? (
        <Popover placement="top" trigger={(p) => <button className="tab new" aria-label="New" {...p}><span className="plus"><Plus size={22} /></span></button>}>
          <div className="menu-label">Create</div>
          <MenuItem icon={<FileText size={18} />} onClick={() => s.createPage({})}>Page</MenuItem>
          <MenuItem icon={<Table2 size={18} />} onClick={() => s.createPage({ kind: 'database' })}>Database</MenuItem>
          <MenuItem icon={<Lock size={18} />} onClick={() => s.createPage({ visibility: 'private' })}>Private Page</MenuItem>
        </Popover>
      ) : <span className="tab" />}
      <button className="tab" onClick={s.openPalette}><Search size={22} /><span>Search</span></button>
      {tab(`/w/${s.wid}/more`, false, <Avatar name={s.user.name} color={s.user.color} />, 'More')}
    </nav>
  );
}

/** Phone "Pages" tab: the whole page tree, full width. */
export function BrowsePage() {
  const s = useShell();
  return (
    <>
      <header className="topbar"><h1 className="phone-title">Pages</h1></header>
      <div className="content"><div className="browse"><PageTree /></div></div>
      {!s.phone && <Navigate to={`/w/${s.wid}`} replace />}
    </>
  );
}

/** Phone "More" tab: workspaces, settings and account. */
export function MorePage() {
  const s = useShell();
  const navigate = useNavigate();
  const { onNewWorkspace } = useOutletContext<{ onNewWorkspace: () => void }>();
  const row = (icon: React.ReactNode, label: string, onClick: () => void, danger = false) => (
    <button className={`more-row${danger ? ' danger' : ''}`} onClick={onClick}>{icon}<span className="grow">{label}</span><ChevronRight size={18} /></button>
  );
  return (
    <>
      <header className="topbar"><h1 className="phone-title">More</h1></header>
      <div className="content"><div className="browse">
        <div className="more-me"><Avatar name={s.user.name} color={s.user.color} large /><span><b>{s.user.name}</b><div className="subtle">{s.user.email}</div></span></div>
        <div className="side-head"><span>Workspaces</span></div>
        <div className="more-group">
          {s.boot.workspaces.map((w) => (
            <button key={w.id} className="more-row" onClick={() => navigate(`/w/${w.id}`)}><WsBadge {...w} /><span className="grow">{w.name}</span>{w.id === s.wid ? <Check size={18} color="var(--accent)" /> : <ChevronRight size={18} />}</button>
          ))}
          {row(<Plus size={20} />, 'New Workspace', onNewWorkspace)}
        </div>
        <div className="side-head"><span>{s.workspace.name}</span></div>
        <div className="more-group">
          {row(<Users size={20} />, 'Members', () => s.openSettings('members'))}
          {row(<Trash2 size={20} />, 'Trash', () => navigate(`/w/${s.wid}/trash`))}
          {row(<SettingsIcon size={20} />, 'Settings', () => s.openSettings('account'))}
          {row(<Sparkles size={20} />, 'Connect AI (MCP)', () => s.openSettings('ai'))}
        </div>
        <div className="more-group" style={{ marginTop: 24 }}>{row(<LogOut size={20} />, 'Sign Out', s.signOut, true)}</div>
      </div></div>
      {!s.phone && <Navigate to={`/w/${s.wid}`} replace />}
    </>
  );
}

function WorkspaceSwitcher({ onNew }: { onNew: () => void }) {
  const s = useShell();
  const navigate = useNavigate();
  return (
    <Popover trigger={(p) => (
      <button className="ws-switch" {...p} aria-label={`Workspace: ${s.workspace.name}. Switch workspace`}>
        <WsBadge {...s.workspace} /><span className="grow">{s.workspace.name}</span><ChevronsUpDown size={14} color="var(--text-3)" />
      </button>
    )}>
      <div className="menu-label">Workspaces</div>
      {s.boot.workspaces.map((w) => (
        <MenuItem key={w.id} icon={<WsBadge {...w} />} hint={w.id === s.wid ? <Check size={15} /> : undefined} onClick={() => navigate(`/w/${w.id}`)}>{w.name}</MenuItem>
      ))}
      <div className="menu-sep" />
      <MenuItem icon={<Plus size={16} />} onClick={onNew}>New Workspace</MenuItem>
      <MenuItem icon={<Users size={16} />} onClick={() => s.openSettings('members')}>Members</MenuItem>
      <MenuItem icon={<SettingsIcon size={16} />} onClick={() => s.openSettings('workspace')}>Workspace Settings</MenuItem>
    </Popover>
  );
}

function NewMenu({ parentId, visibility, label }: { parentId: string | null; visibility?: Visibility; label: string }) {
  const s = useShell();
  return (
    <Popover trigger={(p) => <button className="icon-btn" aria-label={label} title={label} {...p}><Plus size={15} /></button>}>
      <MenuItem icon={<FileText size={16} />} onClick={() => s.createPage({ parentId, visibility })}>Page</MenuItem>
      <MenuItem icon={<Table2 size={16} />} onClick={() => s.createPage({ parentId, visibility, kind: 'database' })}>Database</MenuItem>
    </Popover>
  );
}

let dragId: string | null = null;

function TreeItem({ node, depth, byParent, open, toggle }: {
  node: TreeNode; depth: number; byParent: Map<string | null, TreeNode[]>; open: Record<string, boolean>; toggle: (id: string, v?: boolean) => void;
}) {
  const s = useShell();
  const ui = useUi();
  const { pid } = useParams();
  const kids = byParent.get(node.id) ?? [];
  const isOpen = !!open[node.id];
  const [drop, setDrop] = useState<'' | 'in' | 'after'>('');
  const isFav = s.tree?.favorites.includes(node.id) ?? false;

  const onDragOver = (e: DragEvent) => {
    if (!dragId || dragId === node.id || !s.canEdit) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDrop(e.clientY - r.top > r.height * 0.7 ? 'after' : 'in');
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const id = dragId; const where = drop;
    setDrop(''); dragId = null;
    if (!id || id === node.id) return;
    try {
      await post(`/api/pages/${id}/move`, where === 'in' ? { parentId: node.id } : { parentId: node.parentId, afterId: node.id });
      if (where === 'in') toggle(node.id, true);
      invalidateWorkspace(s.wid);
      qc.invalidateQueries({ queryKey: ['page', id] });
    } catch (err) { ui.toast((err as Error).message); }
  };

  return (
    <>
      <div
        className={`tree-row${pid === node.id ? ' active' : ''}${drop ? ` drop-${drop}` : ''}`}
        style={{ paddingLeft: 2 + depth * 14 }}
        draggable={s.canEdit}
        onDragStart={(e) => { dragId = node.id; e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { dragId = null; }}
        onDragOver={onDragOver} onDragLeave={() => setDrop('')} onDrop={onDrop}
      >
        <button className={`twist${isOpen ? ' open' : ''}`} aria-label={isOpen ? 'Collapse' : 'Expand'} aria-expanded={isOpen} onClick={() => toggle(node.id)}>
          <ChevronRight size={14} />
        </button>
        <Link to={`/w/${s.wid}/p/${node.id}`} draggable={false}>
          <PageIcon icon={node.icon} kind={node.kind} /><span className="t">{node.title || 'Untitled'}</span>
        </Link>
        {s.canEdit && (
          <span className="acts">
            <Popover trigger={(p) => <button className="icon-btn" aria-label="More actions" {...p}><MoreHorizontal size={15} /></button>}>
              <MenuItem icon={isFav ? <StarOff size={16} /> : <Star size={16} />} onClick={() => s.toggleFavorite(node.id, !isFav)}>{isFav ? 'Remove from Favorites' : 'Add to Favorites'}</MenuItem>
              <MenuItem icon={<Copy size={16} />} onClick={async () => { await post(`/api/pages/${node.id}/duplicate`); invalidateWorkspace(s.wid); }}>Duplicate</MenuItem>
              {node.parentId === null && node.createdBy === s.user.id && (
                <MenuItem icon={node.visibility === 'private' ? <Users size={16} /> : <Lock size={16} />} onClick={async () => {
                  await patch(`/api/pages/${node.id}`, { visibility: node.visibility === 'private' ? 'workspace' : 'private' });
                  invalidateWorkspace(s.wid);
                }}>{node.visibility === 'private' ? 'Share with Workspace' : 'Make Private'}</MenuItem>
              )}
              <div className="menu-sep" />
              <MenuItem danger icon={<Trash2 size={16} />} onClick={() => s.trashPage(node.id, node.title)}>Move to Trash</MenuItem>
            </Popover>
            {node.kind === 'page' && (
              <button className="icon-btn" aria-label="Add a page inside" title="Add a page inside" onClick={() => { toggle(node.id, true); s.createPage({ parentId: node.id }); }}>
                <Plus size={15} />
              </button>
            )}
          </span>
        )}
      </div>
      {isOpen && (kids.length
        ? kids.map((k) => <TreeItem key={k.id} node={k} depth={depth + 1} byParent={byParent} open={open} toggle={toggle} />)
        : <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>{node.kind === 'database' ? 'Rows open from the table' : 'No pages inside'}</div>)}
    </>
  );
}

// ---------- Command palette ----------
interface Cmd { id: string; title: string; sub?: string; icon: React.ReactNode; run: () => void; html?: string }

function Palette({ onClose }: { onClose: () => void }) {
  const s = useShell();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => searchPages(s.wid, term).then((h) => { if (live) { setHits(h); setActive(0); } }).catch(() => {}), 120);
    return () => { live = false; clearTimeout(t); };
  }, [q, s.wid]);

  // replace: the palette's Back marker entry becomes the destination, so Back returns to where search was opened.
  const go = (path: string) => { navigate(path, { replace: true }); onClose(); };
  const actions: Cmd[] = [
    ...(s.canEdit ? [
      { id: 'new', title: 'New Page', icon: <FilePlus2 size={17} />, run: () => { s.createPage({}); onClose(); } },
      { id: 'newdb', title: 'New Database', icon: <Table2 size={17} />, run: () => { s.createPage({ kind: 'database' }); onClose(); } },
    ] : []),
    { id: 'home', title: 'Go to Home', icon: <HomeIcon size={17} />, run: () => go(`/w/${s.wid}`) },
    { id: 'trash', title: 'Go to Trash', icon: <Trash2 size={17} />, run: () => go(`/w/${s.wid}/trash`) },
    { id: 'settings', title: 'Open Settings', icon: <SettingsIcon size={17} />, run: () => { onClose(); s.openSettings('account'); } },
    { id: 'ai', title: 'Connect AI (MCP)', icon: <Sparkles size={17} />, run: () => { onClose(); s.openSettings('ai'); } },
    ...s.boot.workspaces.filter((w) => w.id !== s.wid).map((w) => ({ id: `ws${w.id}`, title: `Switch to ${w.name}`, icon: <WsBadge {...w} />, run: () => go(`/w/${w.id}`) })),
  ];
  const term = q.trim().toLowerCase();
  const recents = (s.tree?.nodes ?? []).slice(0, 6);
  const items: Cmd[] = term
    ? [
        ...hits.map((h) => ({ id: h.id, title: h.title || 'Untitled', sub: [h.path, h.snippet].filter(Boolean).join(' · '), html: h.snippet, icon: <PageIcon icon={h.icon} kind={h.kind} />, run: () => go(`/w/${s.wid}/p/${h.id}`) })),
        ...actions.filter((a) => a.title.toLowerCase().includes(term)),
        ...(s.canEdit ? [{ id: 'create', title: `Create page “${q.trim()}”`, icon: <Plus size={17} />, run: () => { s.createPage({ title: q.trim() }); onClose(); } }] : []),
      ]
    : [
        ...recents.map((n) => ({ id: n.id, title: n.title || 'Untitled', icon: <PageIcon icon={n.icon} kind={n.kind} />, run: () => go(`/w/${s.wid}/p/${n.id}`) })),
        ...actions,
      ];

  useEffect(() => { listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  return (
    <Modal onClose={onClose} className="palette" label="Search and commands">
      <div className="palette-input">
        <Search size={18} />
        <input
          autoFocus value={q} placeholder={s.phone ? 'Search' : 'Search pages, or type a command…'} aria-label="Search"
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
          }}
        />
        {s.phone && <button className="btn ghost palette-cancel" onClick={onClose}>Cancel</button>}
      </div>
      <div className="palette-list" ref={listRef}>
        {items.map((it, i) => (
          <button key={it.id} className={`palette-item${i === active ? ' active' : ''}`} onMouseMove={() => setActive(i)} onClick={it.run}>
            {it.icon}
            <span className="grow">
              <div className="t">{it.title}</div>
              {it.sub && (it.html ? <div className="s" dangerouslySetInnerHTML={{ __html: safeSnippet(it.sub) }} /> : <div className="s">{it.sub}</div>)}
            </span>
          </button>
        ))}
        {items.length === 0 && <div className="empty">No results for “{q}”.</div>}
      </div>
      <div className="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span></div>
    </Modal>
  );
}

// Snippets are plain text from the server with <mark> around matches; escape everything else.
function safeSnippet(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;(\/?)mark&gt;/g, '<$1mark>');
}

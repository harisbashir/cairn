import { ChevronLeft, ChevronRight, FilePlus2, PanelLeft, RotateCcw, Search, Sparkles, Table2, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Activity, Crumb } from '../../shared/types.ts';
import { MOD, del, invalidateWorkspace, post, timeAgo, useActivity, useRecent, useTrash } from './api.ts';
import { PageIcon, useShell, visitedPaths } from './Shell.tsx';
import { useUi } from './ui.tsx';

export function TopBar({ crumbs = [], here, children, back }: { crumbs?: Crumb[]; here: ReactNode; children?: ReactNode; back?: boolean }) {
  const s = useShell();
  const navigate = useNavigate();
  const parent = crumbs[crumbs.length - 1];
  // Back pops history when the previous entry is where we'd go anyway (keeps the stack and scroll position sane);
  // otherwise it goes up to the parent page, or Home. It never leaves the app: history.length also counts other sites.
  const goBack = () => {
    const idx: number = window.history.state?.idx ?? 0;
    const prev = idx > 0 ? visitedPaths.get(idx - 1) : undefined;
    const target = parent ? `/w/${s.wid}/p/${parent.id}` : undefined;
    if (prev && (!target || prev === target)) navigate(-1);
    else navigate(target ?? `/w/${s.wid}`);
  };
  return (
    <header className="topbar">
      {s.collapsed && <button className="icon-btn" aria-label="Show sidebar" title={`Show sidebar (${MOD}\\)`} onClick={s.toggleSidebar}><PanelLeft size={17} /></button>}
      {s.phone && back && (
        <button className="back-btn" aria-label={parent ? `Back to ${parent.title || 'Untitled'}` : 'Back'}
          onClick={goBack}>
          <ChevronLeft size={22} /><span>{parent ? parent.title || 'Untitled' : 'Back'}</span>
        </button>
      )}
      <nav className="crumbs" aria-label="Location">
        {!s.phone && crumbs.map((c) => (
          <span key={c.id} style={{ display: 'contents' }}>
            <Link to={`/w/${s.wid}/p/${c.id}`}><PageIcon icon={c.icon} kind={c.kind} />{c.title || 'Untitled'}</Link>
            <ChevronRight className="sep" size={14} />
          </span>
        ))}
        <span className="here" aria-current="page">{here}</span>
      </nav>
      {children}
    </header>
  );
}

export function AiTag() {
  return <span className="ai-tag" title="Changed by an AI agent through MCP"><Sparkles size={11} />AI</span>;
}

const VERB: Record<Activity['action'], string> = {
  created: 'created', updated: 'edited', deleted: 'moved to Trash', restored: 'restored', moved: 'moved', shared: 'shared', joined: 'joined the workspace',
};

export function Home() {
  const s = useShell();
  const recent = useRecent(s.wid);
  const activity = useActivity(s.wid);
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const empty = recent.data && recent.data.length === 0;
  return (
    <>
      <TopBar here="Home" />
      <div className="content">
        <div className="home">
          <h1>{hello}, {s.user.name.split(' ')[0]}</h1>
          <p className="lead">{s.workspace.name}</p>
          <div className="quick">
            {s.canEdit && <button className="btn primary large" onClick={() => s.createPage({})}><FilePlus2 size={17} />New Page</button>}
            {s.canEdit && <button className="btn large" onClick={() => s.createPage({ kind: 'database' })}><Table2 size={17} />New Database</button>}
            <button className="btn large" onClick={s.openPalette}><Search size={17} />Search</button>
            <button className="btn large" onClick={() => s.openSettings('ai')}><Sparkles size={17} />Connect AI</button>
          </div>

          <div className="section-h">Jump back in</div>
          {empty ? (
            <div className="feed"><div className="empty">
              <span>Nothing here yet. Start with a page, or a database to track things.</span>
            </div></div>
          ) : (
            <div className="cards">
              {recent.data?.map((p) => (
                <Link key={p.id} className="card" to={`/w/${s.wid}/p/${p.id}`}>
                  <span className="ico emoji">{p.icon || <PageIcon icon="" kind={p.kind} size={22} />}</span>
                  <span>
                    <div className="t">{p.title || 'Untitled'}</div>
                    <div className="m">{p.path ? `${p.path} · ` : ''}{timeAgo(p.updatedAt)}</div>
                  </span>
                </Link>
              ))}
            </div>
          )}

          <div className="section-h">Latest activity</div>
          <div className="feed">
            {activity.data?.length === 0 && <div className="empty">Changes by you, your team and your AI agents show up here.</div>}
            {activity.data?.map((a) => {
              const body = (
                <>
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <b>{a.actorName}</b> {a.actorType === 'ai' && <AiTag />} <span className="muted">{VERB[a.action]}</span>{' '}
                    {a.pageId && <><span className="emoji">{a.pageIcon}</span> <b>{a.pageTitle || 'Untitled'}</b></>}
                  </span>
                  <span className="when">{timeAgo(a.at)}</span>
                </>
              );
              return a.pageId && a.action !== 'deleted'
                ? <Link key={a.id} className="feed-row" to={`/w/${s.wid}/p/${a.pageId}`}>{body}</Link>
                : <div key={a.id} className="feed-row">{body}</div>;
            })}
          </div>
        </div>
      </div>
    </>
  );
}

export function TrashPage() {
  const s = useShell();
  const ui = useUi();
  const trash = useTrash(s.wid);
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); invalidateWorkspace(s.wid); } catch (err) { ui.toast((err as Error).message); }
  };
  return (
    <>
      <TopBar here="Trash" back />
      <div className="content">
        <div className="home">
          <h1>Trash</h1>
          <p className="lead">Pages stay here until you delete them for good.</p>
          <div className="section-h" />
          <div className="feed">
            {trash.data?.length === 0 && <div className="empty"><Trash2 size={22} />Trash is empty.</div>}
            {trash.data?.map((t) => (
              <div key={t.id} className="feed-row">
                <PageIcon icon={t.icon} kind={t.kind} />
                <span className="grow"><b>{t.title || 'Untitled'}</b> <span className="when">· {t.deletedByName}, {timeAgo(t.deletedAt)}</span></span>
                {s.canEdit && (
                  <>
                    <button className="btn small" onClick={() => act(() => post(`/api/pages/${t.id}/restore`))}><RotateCcw size={14} />Restore</button>
                    <button className="btn small danger" onClick={async () => {
                      if (await ui.confirm({ title: `Delete “${t.title || 'Untitled'}” forever?`, body: 'This also deletes everything inside it. You can’t undo this.', action: 'Delete Forever', danger: true })) {
                        act(() => del(`/api/pages/${t.id}?permanent=1`));
                      }
                    }}>Delete Forever</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

import { Copy, Globe, History, Link2, MoreHorizontal, RotateCcw, SmilePlus, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DocNode, Page, Props } from '../../shared/types.ts';
import { clientId, del, invalidateWorkspace, post, qc, timeAgo, usePage, useVersions, useWsUsers } from './api.ts';
import { DatabaseView, PropIcon, PropValueEditor } from './Database.tsx';
import { Editor } from './Editor.tsx';
import { AiTag, TopBar } from './Home.tsx';
import { PageIcon, useShell } from './Shell.tsx';
import { CopyButton, EmojiPicker, MenuItem, Modal, Popover, Switch, useUi } from './ui.tsx';

export function PageRoute() {
  const { pid } = useParams();
  const s = useShell();
  const page = usePage(pid);
  if (page.isPending) return <TopBar here="" />;
  if (page.isError || !page.data) {
    return (
      <>
        <TopBar back here="Not found" />
        <div className="content"><div className="empty" style={{ paddingTop: 120 }}>
          <h2>This page isn’t available</h2>
          <span>It may have been deleted, or it’s private to someone else.</span>
          <Link className="btn" to={`/w/${s.wid}`}>Go to Home</Link>
        </div></div>
      </>
    );
  }
  return <PageView key={page.data.id} page={page.data} />;
}

type Patch = Partial<Pick<Page, 'title' | 'icon' | 'content' | 'schema' | 'views' | 'visibility'>> & { props?: Props };

// Debounced, merged saving. Returns the save function and a status label.
export function useSaver(page: Page) {
  const s = useShell();
  const ui = useUi();
  const pending = useRef<Patch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ownStamp = useRef<string>('');
  const [status, setStatus] = useState<'' | 'saving' | 'saved' | 'error'>('');

  const flush = useCallback(async (keepalive = false) => {
    clearTimeout(timer.current);
    const body = pending.current;
    if (!Object.keys(body).length) return;
    pending.current = {};
    setStatus('saving');
    try {
      const res = await fetch(`/api/pages/${page.id}`, {
        method: 'PATCH', keepalive, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Cairn-Client': clientId }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? 'Couldn’t save.');
      const saved = data as Page;
      ownStamp.current = saved.updatedAt;
      qc.setQueryData<Page>(['page', page.id], (old) => (old ? { ...old, ...saved, breadcrumbs: old.breadcrumbs, favorite: old.favorite, shareToken: old.shareToken, canEdit: old.canEdit, parentSchema: old.parentSchema } : old));
      if (!Object.keys(pending.current).length) { setStatus('saved'); window.dispatchEvent(new Event('cairn:saved')); }
      if ('title' in body || 'icon' in body || 'visibility' in body) invalidateWorkspace(s.wid);
      if (page.kind === 'row') qc.invalidateQueries({ queryKey: ['rows', page.parentId] });
    } catch (err) {
      pending.current = { ...body, ...pending.current };
      setStatus('error');
      ui.toast(`Couldn’t save: ${(err as Error).message}`);
    }
  }, [page.id, page.kind, page.parentId, s.wid, ui]);

  const save = useCallback((patch: Patch, now = false) => {
    pending.current = { ...pending.current, ...patch, ...(patch.props ? { props: { ...pending.current.props, ...patch.props } } : {}) };
    setStatus('saving');
    clearTimeout(timer.current);
    if (now) void flush(); else timer.current = setTimeout(() => void flush(), 700);
  }, [flush]);

  useEffect(() => {
    const leave = () => void flush(true);
    window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('beforeunload', leave); void flush(true); };
  }, [flush]);

  return { save, status, ownStamp };
}

function PageView({ page }: { page: Page }) {
  const s = useShell();
  const ui = useUi();
  const canEdit = !!page.canEdit && !page.deletedAt;
  const { save, status, ownStamp } = useSaver(page);
  const [title, setTitle] = useState(page.title);
  const [icon, setIcon] = useState(page.icon);
  const [version, setVersion] = useState(page.updatedAt);
  const [history, setHistory] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const titleDirty = useRef(false);
  const users = useWsUsers(s.wid);

  // Adopt remote changes (another person, another tab, or an AI agent).
  useEffect(() => {
    if (page.updatedAt === ownStamp.current) return;
    setVersion(page.updatedAt);
    if (!titleDirty.current) { setTitle(page.title); setIcon(page.icon); }
  }, [page.updatedAt, page.title, page.icon, ownStamp]);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = '0'; el.style.height = `${el.scrollHeight}px`; }
  }, [title]);
  // A new page starts in its title. Menus hand focus back to their button when they close, so claim it after that too.
  useEffect(() => {
    if (page.title || !canEdit) return;
    titleRef.current?.focus();
    const t = setTimeout(() => { if (!document.activeElement?.closest('.tiptap')) titleRef.current?.focus(); }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, canEdit]);
  useEffect(() => { document.title = `${title || 'Untitled'} · Cairn`; return () => { document.title = 'Cairn'; }; }, [title]);

  const setTitleSaved = (v: string) => {
    titleDirty.current = true; setTitle(v); save({ title: v });
    setTimeout(() => { titleDirty.current = false; }, 1500);
  };
  const pickIcon = (e: string) => { setIcon(e); save({ icon: e }, true); };
  const isDb = page.kind === 'database';

  return (
    <>
      <TopBar back crumbs={page.breadcrumbs} here={<><PageIcon icon={icon} kind={page.kind} />{title || 'Untitled'}</>}>
        <span className="saved" aria-live="polite">
          {status === 'saving' ? 'Saving…' : status === 'error' ? 'Not saved' : (
            <>{page.updatedByType === 'ai' && <AiTag />} Edited {timeAgo(page.updatedAt)}</>
          )}
        </span>
        {canEdit && <SharePopover page={page} />}
        <button className={`icon-btn${page.favorite ? ' on' : ''}`} aria-label={page.favorite ? 'Remove from Favorites' : 'Add to Favorites'} aria-pressed={!!page.favorite}
          title={page.favorite ? 'Remove from Favorites' : 'Add to Favorites'} onClick={() => s.toggleFavorite(page.id, !page.favorite)}>
          <Star size={16} fill={page.favorite ? 'currentColor' : 'none'} />
        </button>
        <Popover placement="bottom-end" trigger={(p) => <button className="icon-btn" aria-label="Page actions" {...p}><MoreHorizontal size={17} /></button>}>
          <MenuItem icon={<Link2 size={16} />} onClick={() => { navigator.clipboard.writeText(location.href); ui.toast('Link copied'); }}>Copy Link</MenuItem>
          <MenuItem icon={<History size={16} />} onClick={() => setHistory(true)}>Version History</MenuItem>
          {canEdit && <MenuItem icon={<Copy size={16} />} onClick={async () => { await post(`/api/pages/${page.id}/duplicate`); invalidateWorkspace(s.wid); qc.invalidateQueries({ queryKey: ['rows', page.parentId] }); ui.toast('Duplicated'); }}>Duplicate</MenuItem>}
          {canEdit && <><div className="menu-sep" /><MenuItem danger icon={<Trash2 size={16} />} onClick={() => s.trashPage(page.id, title)}>Move to Trash</MenuItem></>}
        </Popover>
      </TopBar>
      {page.deletedAt && (
        <div className="banner" role="status">
          <Trash2 size={16} /><span className="grow">This page is in Trash.</span>
          {page.canEdit && <button className="btn small" onClick={async () => { await post(`/api/pages/${page.id}/restore`); invalidateWorkspace(s.wid); qc.invalidateQueries({ queryKey: ['page', page.id] }); }}><RotateCcw size={14} />Restore</button>}
        </div>
      )}
      <div className="content">
        <div className={`page${isDb ? ' wide' : ''}`}>
          <div className="page-head">
            {icon ? (
              canEdit ? (
                <Popover trigger={(p) => <button className="page-icon-btn emoji" aria-label="Change icon" {...p}>{icon}</button>}>
                  <EmojiPicker onPick={pickIcon} allowRemove />
                </Popover>
              ) : <div className="page-icon-btn emoji">{icon}</div>
            ) : canEdit ? (
              <div className="page-tools">
                <Popover trigger={(p) => <button className="btn ghost small" style={{ color: 'var(--text-3)' }} {...p}><SmilePlus size={15} />Add icon</button>}>
                  <EmojiPicker onPick={pickIcon} />
                </Popover>
              </div>
            ) : null}
            <textarea
              ref={titleRef} className="page-title" rows={1} value={title} placeholder="Untitled" readOnly={!canEdit} aria-label="Page title"
              onChange={(e) => setTitleSaved(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); (document.querySelector('.tiptap') as HTMLElement | null)?.focus(); }
              }}
            />
          </div>

          {page.kind === 'row' && page.parentSchema && page.parentSchema.length > 0 && (
            <div className="props">
              {page.parentSchema.map((prop) => (
                <div className="prop-line" key={prop.id}>
                  <span className="prop-name"><PropIcon type={prop.type} />{prop.name}</span>
                  <PropValueEditor
                    prop={prop} value={page.props[prop.id] ?? null} editable={canEdit} users={users.data ?? []} wid={s.wid}
                    onChange={(v) => {
                      qc.setQueryData<Page>(['page', page.id], (old) => (old ? { ...old, props: { ...old.props, [prop.id]: v } } : old));
                      save({ props: { [prop.id]: v } }, true);
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {isDb ? (
            <DatabaseView page={page} canEdit={canEdit} save={save} />
          ) : (
            <Editor wid={s.wid} content={page.content} version={version} editable={canEdit} pages={s.tree?.nodes ?? []} onChange={(doc: DocNode) => save({ content: doc })} />
          )}
        </div>
      </div>
      {history && <HistoryModal page={page} onClose={() => setHistory(false)} />}
    </>
  );
}

function SharePopover({ page }: { page: Page }) {
  const ui = useUi();
  const url = page.shareToken ? `${location.origin}/s/${page.shareToken}` : '';
  const toggle = async (on: boolean) => {
    try {
      const token = on ? (await post<{ token: string }>(`/api/pages/${page.id}/share`)).token : (await del(`/api/pages/${page.id}/share`), null);
      qc.setQueryData<Page>(['page', page.id], (old) => (old ? { ...old, shareToken: token } : old));
    } catch (err) { ui.toast((err as Error).message); }
  };
  return (
    <Popover placement="bottom-end" trigger={(p) => <button className="btn ghost small" {...p}>{page.shareToken && <Globe size={14} color="var(--accent)" />}Share</button>}>
      <div className="menu-pad" style={{ width: 320 }}>
        <div className="row">
          <Globe size={18} color="var(--text-2)" />
          <span className="grow"><b>Publish to the web</b><div className="subtle">Anyone with the link can read this page.</div></span>
          <Switch on={!!page.shareToken} onChange={toggle} label="Publish to the web" />
        </div>
        {url && <div className="row"><input className="input small" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Public link" /><CopyButton text={url} label="Copy public link" /></div>}
        <div className="subtle">{page.visibility === 'private' ? 'Private: only you can open this page in the workspace.' : 'Everyone in this workspace can open this page.'}</div>
      </div>
    </Popover>
  );
}

function HistoryModal({ page, onClose }: { page: Page; onClose: () => void }) {
  const s = useShell();
  const ui = useUi();
  const versions = useVersions(page.id, true);
  return (
    <Modal onClose={onClose} label="Version history">
      <h2>Version History</h2>
      <p className="muted">Cairn keeps a snapshot when a page changes. Restoring one keeps the current version in history too.</p>
      <div className="feed" style={{ maxHeight: 360, overflow: 'auto' }}>
        {versions.data?.length === 0 && <div className="empty">No earlier versions yet.</div>}
        {versions.data?.map((v) => (
          <div key={v.id} className="feed-row">
            <span className="grow"><b>{new Date(v.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b>
              <div className="subtle">{v.createdByName} {v.createdByType === 'ai' && <AiTag />} · “{v.title || 'Untitled'}”</div></span>
            {page.canEdit && <button className="btn small" onClick={async () => {
              try {
                await post(`/api/pages/${page.id}/versions/${v.id}/restore`);
                await qc.invalidateQueries({ queryKey: ['page', page.id] });
                invalidateWorkspace(s.wid);
                ui.toast('Version restored'); onClose();
              } catch (err) { ui.toast((err as Error).message); }
            }}>Restore</button>}
          </div>
        ))}
      </div>
      <div className="actions"><button className="btn" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

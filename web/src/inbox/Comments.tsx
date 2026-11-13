import { Check, MessageSquare, MoreHorizontal, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import type { Comment, Page } from '../../../shared/types.ts';
import { api, del, post, qc, timeAgo, useWsUsers } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { Avatar, MenuItem, Modal, Popover, Switch, useBackToClose, useUi } from '../ui.tsx';
import { useComments } from './hooks.ts';
import { MentionInput, MentionText, useMentionDraft } from './mentions.tsx';
import './inbox.css';

/** Text selected in the page body, used as the quote of a new thread. */
function selectedText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el?.closest('.tiptap, .ProseMirror')) return '';
  return sel.toString().replace(/\s+/g, ' ').trim().slice(0, 500);
}

function refresh(pageId: string) {
  qc.invalidateQueries({ queryKey: ['comments', pageId] });
  qc.invalidateQueries({ queryKey: ['page', pageId] });
}

/** Top-bar button with the open-thread count; opens the comments panel. */
export function CommentsButton({ page }: { page: Page }) {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState('');
  const picked = useRef('');

  // Arriving from a comment notification opens the panel.
  useEffect(() => {
    if (params.get('comments') !== '1') return;
    setOpen(true);
    const next = new URLSearchParams(params);
    next.delete('comments');
    setParams(next, { replace: true });
  }, [params, setParams]);
  useEffect(() => { setOpen(false); setQuote(''); }, [page.id]);

  const count = page.commentCount ?? 0;
  return (
    <>
      <button
        className={`icon-btn inb-cbtn${open ? ' open' : ''}${count ? ' has' : ''}`}
        aria-label={count ? `Comments, ${count} open` : 'Comments'} title="Comments" aria-expanded={open}
        // The click would clear the selection, so read it first.
        onPointerDown={() => { picked.current = selectedText(); }}
        onClick={() => {
          if (open) { setOpen(false); return; }
          setQuote(picked.current || selectedText());
          setOpen(true);
        }}
      >
        <MessageSquare size={17} />{count > 0 && <span className="inb-ccount">{count}</span>}
      </button>
      {open && <CommentsPanel page={page} quote={quote} clearQuote={() => setQuote('')} onClose={() => setOpen(false)} />}
    </>
  );
}

function CommentsPanel({ page, quote, clearQuote, onClose }: { page: Page; quote: string; clearQuote: () => void; onClose: () => void }) {
  const s = useShell();
  if (s.phone) {
    return (
      <Modal className="modal inb-csheet" label="Comments" onClose={onClose} focusDialog>
        <CommentsBody page={page} quote={quote} clearQuote={clearQuote} onClose={onClose} />
      </Modal>
    );
  }
  return <Drawer onClose={onClose}><CommentsBody page={page} quote={quote} clearQuote={clearQuote} onClose={onClose} /></Drawer>;
}

/** Desktop: a panel on the right that leaves the page usable. */
function Drawer({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useBackToClose(onClose);
  useEffect(() => {
    document.body.classList.add('inb-drawer-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement?.closest('.inb-drawer')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.classList.remove('inb-drawer-open'); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return createPortal(<aside className="inb-drawer" aria-label="Comments">{children}</aside>, document.body);
}

interface Thread { id: string; quote: string; resolved: boolean; comments: Comment[] }

function CommentsBody({ page, quote, clearQuote, onClose }: { page: Page; quote: string; clearQuote: () => void; onClose: () => void }) {
  const s = useShell();
  const ui = useUi();
  const comments = useComments(page.id);
  const users = useWsUsers(s.wid);
  const [showResolved, setShowResolved] = useState(false);
  const draft = useMentionDraft();
  const [busy, setBusy] = useState(false);

  const colors = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u.color])), [users.data]);
  const threads = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const c of comments.data ?? []) {
      let t = map.get(c.threadId);
      if (!t) { t = { id: c.threadId, quote: '', resolved: false, comments: [] }; map.set(c.threadId, t); }
      if (c.id === c.threadId) { t.quote = c.quote; t.resolved = c.resolved; }
      t.comments.push(c);
    }
    // Newest activity last, like a conversation.
    return [...map.values()].sort((a, b) => a.comments[0].createdAt.localeCompare(b.comments[0].createdAt));
  }, [comments.data]);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const shown = showResolved ? threads : open;

  const send = async () => {
    const body = draft.toBody();
    if (!body || busy) return;
    setBusy(true);
    try {
      await post(`/api/pages/${page.id}/comments`, { body, ...(quote ? { quote } : {}) });
      draft.reset();
      clearQuote();
      refresh(page.id);
    } catch (err) { ui.toast((err as Error).message); }
    setBusy(false);
  };

  const listRef = useRef<HTMLDivElement>(null);
  const count = comments.data?.length ?? 0;
  const prev = useRef(count);
  useEffect(() => {
    if (count > prev.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    prev.current = count;
  }, [count]);

  return (
    <div className="inb-comments">
      <div className="inb-chead">
        <h2>Comments</h2>
        {resolved.length > 0 && (
          <label className="inb-toggle">
            <span>Show resolved ({resolved.length})</span>
            <Switch on={showResolved} onChange={setShowResolved} label="Show resolved threads" />
          </label>
        )}
        {!s.phone && <button className="icon-btn" aria-label="Close comments" onClick={onClose}><X size={17} /></button>}
      </div>
      <div className="inb-threads" ref={listRef}>
        {comments.isPending && <div className="inb-quiet">Loading…</div>}
        {comments.isError && <div className="inb-quiet">Comments can’t load right now. {comments.error.message}</div>}
        {comments.data && shown.length === 0 && (
          <div className="inb-empty">
            <MessageSquare size={22} aria-hidden />
            <b>{resolved.length ? 'No open comments' : 'No comments yet'}</b>
            <span>Select text on the page before opening comments to comment on it.</span>
          </div>
        )}
        {shown.map((t) => <ThreadCard key={t.id} t={t} page={page} colors={colors} />)}
      </div>
      <div className="inb-compose">
        {quote && (
          <div className="inb-quote compose">
            <span className="grow">{quote}</span>
            <button className="icon-btn" aria-label="Remove quote" onClick={clearQuote}><X size={14} /></button>
          </div>
        )}
        <div className="inb-compose-row">
          <MentionInput
            wid={s.wid} draft={draft} onSubmit={send} autoFocus={!s.phone || !!quote}
            placeholder={quote ? 'Comment on the selection…' : 'Add a comment…'} label="New comment"
          />
          <button className="btn primary small inb-send" onClick={send} disabled={!draft.text.trim() || busy}>Send</button>
        </div>
      </div>
    </div>
  );
}

function ThreadCard({ t, page, colors }: { t: Thread; page: Page; colors: Map<string, string> }) {
  const s = useShell();
  const ui = useUi();
  const [replying, setReplying] = useState(false);
  const draft = useMentionDraft();
  const canResolve = !!page.canEdit;

  const setResolved = async (resolved: boolean) => {
    try { await api('PATCH', `/api/comments/${t.id}`, { resolved }); refresh(page.id); }
    catch (err) { ui.toast((err as Error).message); }
  };
  const reply = async () => {
    const body = draft.toBody();
    if (!body) return;
    try {
      await post(`/api/pages/${page.id}/comments`, { body, threadId: t.id });
      draft.reset();
      setReplying(false);
      refresh(page.id);
    } catch (err) { ui.toast((err as Error).message); }
  };

  return (
    <section className={`inb-thread${t.resolved ? ' resolved' : ''}`} aria-label={t.quote ? `Thread on “${t.quote}”` : 'Page comment'}>
      <div className="inb-thread-top">
        {t.quote ? <div className="inb-quote grow">{t.quote}</div> : <div className="inb-thread-kind grow">Page comment</div>}
        {canResolve && (
          t.resolved
            ? <button className="btn ghost small" onClick={() => setResolved(false)}><RotateCcw size={14} />Reopen</button>
            : <button className="icon-btn" aria-label="Resolve thread" title="Resolve" onClick={() => setResolved(true)}><Check size={16} /></button>
        )}
      </div>
      {t.comments.map((c) => <CommentItem key={c.id} c={c} color={colors.get(c.createdBy) ?? '#868e96'} mine={c.createdBy === s.user.id} pageId={page.id} />)}
      {!t.resolved && (replying ? (
        <div className="inb-reply">
          <MentionInput wid={s.wid} draft={draft} onSubmit={reply} autoFocus placeholder="Reply…" label="Reply" onCancel={() => { draft.reset(); setReplying(false); }} />
          <div className="inb-reply-acts">
            <button className="btn ghost small" onClick={() => { draft.reset(); setReplying(false); }}>Cancel</button>
            <button className="btn primary small" onClick={reply} disabled={!draft.text.trim()}>Reply</button>
          </div>
        </div>
      ) : (
        <button className="inb-reply-btn" onClick={() => setReplying(true)}>Reply</button>
      ))}
    </section>
  );
}

function CommentItem({ c, color, mine, pageId }: { c: Comment; color: string; mine: boolean; pageId: string }) {
  const s = useShell();
  const ui = useUi();
  const [editing, setEditing] = useState(false);
  const draft = useMentionDraft(c.body);
  const admin = s.workspace.role === 'owner' || s.workspace.role === 'admin';
  const first = c.id === c.threadId;

  const save = async () => {
    const body = draft.toBody();
    if (!body) return;
    try { await api('PATCH', `/api/comments/${c.id}`, { body }); setEditing(false); refresh(pageId); }
    catch (err) { ui.toast((err as Error).message); }
  };
  const remove = async () => {
    const ok = await ui.confirm({
      title: first ? 'Delete this thread?' : 'Delete this comment?',
      body: first ? 'The replies are deleted too.' : undefined, action: 'Delete', danger: true,
    });
    if (!ok) return;
    try { await del(`/api/comments/${c.id}`); refresh(pageId); }
    catch (err) { ui.toast((err as Error).message); }
  };

  return (
    <div className="inb-comment">
      <Avatar name={c.createdByName} color={color} />
      <div className="inb-comment-main">
        <div className="inb-comment-head">
          <b className="inb-ell">{c.createdByName}</b>
          <span className="inb-time" title={new Date(c.createdAt).toLocaleString()}>{timeAgo(c.createdAt)}{c.updatedAt !== c.createdAt ? ' · edited' : ''}</span>
          {(mine || admin) && !editing && (
            <Popover placement="bottom-end" trigger={(p) => <button className="icon-btn inb-cmenu" aria-label="Comment actions" {...p}><MoreHorizontal size={15} /></button>}>
              {mine && <MenuItem icon={<Pencil size={15} />} onClick={() => { draft.reset(c.body); setEditing(true); }}>Edit</MenuItem>}
              <MenuItem danger icon={<Trash2 size={15} />} onClick={remove}>{first ? 'Delete Thread' : 'Delete'}</MenuItem>
            </Popover>
          )}
        </div>
        {editing ? (
          <div className="inb-reply">
            <MentionInput wid={s.wid} draft={draft} onSubmit={save} autoFocus placeholder="Edit comment" label="Edit comment" onCancel={() => setEditing(false)} />
            <div className="inb-reply-acts">
              <button className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn primary small" onClick={save} disabled={!draft.text.trim()}>Save</button>
            </div>
          </div>
        ) : <div className="inb-comment-body"><MentionText text={c.body} /></div>}
      </div>
    </div>
  );
}

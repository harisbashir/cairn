import { AlarmClock, AtSign, Bell, CheckCheck, MessageSquare, Repeat, UserPlus, type LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { Notification, NotificationKind, Page } from '../../../shared/types.ts';
import { get, timeAgo } from '../api.ts';
import { TopBar } from '../Home.tsx';
import { PageIcon, useShell } from '../Shell.tsx';
import { Popover, useUi } from '../ui.tsx';
import { markRead, useNotificationCount, useNotifications, useReminders, type UpcomingReminder } from './hooks.ts';
import { mentionsToPlain } from './mentions.tsx';
import './inbox.css';

const KIND: Record<NotificationKind, { icon: LucideIcon; label: string }> = {
  reminder: { icon: AlarmClock, label: 'Reminder' },
  mention: { icon: AtSign, label: 'Mention' },
  comment: { icon: MessageSquare, label: 'Comment' },
  assigned: { icon: UserPlus, label: 'Assigned to you' },
  repeat: { icon: Repeat, label: 'Repeated' },
};

/** Where a notification leads: the page, with the comments open when it came from a comment. */
export function notificationHref(n: Notification) {
  if (!n.pageId) return null;
  const fromComment = n.kind === 'comment' || (n.kind === 'mention' && n.body !== `${n.actorName} mentioned you`);
  return `/w/${n.workspaceId}/p/${n.pageId}${fromComment ? '?comments=1' : ''}`;
}

export function useOpenNotification() {
  const navigate = useNavigate();
  const ui = useUi();
  return (n: Notification, after?: () => void) => {
    if (!n.read) markRead([n.id]).catch((err) => ui.toast((err as Error).message));
    const href = notificationHref(n);
    after?.();
    if (href) navigate(href);
  };
}

export function UnreadBadge({ className = '' }: { className?: string }) {
  const count = useNotificationCount();
  const n = count.data?.unread ?? 0;
  if (!n) return null;
  return <span className={`inb-badge ${className}`} aria-label={`${n} unread`}>{n > 99 ? '99+' : n}</span>;
}

export function NotificationRow({ n, onOpen, compact }: { n: Notification; onOpen: (n: Notification) => void; compact?: boolean }) {
  const { icon: Icon, label } = KIND[n.kind] ?? KIND.comment;
  const body = mentionsToPlain(n.body);
  const showBody = body && body !== 'Reminder';
  return (
    <button type="button" className={`inb-note${n.read ? '' : ' unread'}${compact ? ' compact' : ''}`} onClick={() => onOpen(n)} disabled={!n.pageId && n.read}>
      <span className={`inb-kind k-${n.kind}`} aria-hidden><Icon size={compact ? 14 : 16} /></span>
      <span className="inb-note-main">
        <span className="inb-note-title"><b>{n.title || 'Untitled'}</b></span>
        {showBody && <span className="inb-note-body">{body}</span>}
        <span className="inb-note-meta">{n.actorName ? `${n.actorName} · ` : `${label} · `}{timeAgo(n.at)}</span>
      </span>
      {!n.read && <span className="inb-dot" aria-label="Unread" />}
    </button>
  );
}

function fireLabel(r: UpcomingReminder) {
  const d = new Date(r.fireAt);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function UpcomingReminders({ wid, limit, onOpen, compact }: { wid: string; limit?: number; onOpen?: () => void; compact?: boolean }) {
  const reminders = useReminders(wid);
  const list = (reminders.data ?? []).slice(0, limit);
  if (reminders.isError) return <div className="inb-quiet">Upcoming reminders can’t load right now.</div>;
  if (reminders.data && list.length === 0) return <div className="inb-quiet">No reminders in the next two weeks.</div>;
  return (
    <div className="inb-reminders">
      {list.map((r) => (
        <Link key={`${r.pageId}-${r.fireAt}`} to={`/w/${wid}/p/${r.pageId}`} className={`inb-reminder${compact ? ' compact' : ''}`} onClick={onOpen}>
          <PageIcon icon={r.icon} kind="page" />
          <span className="grow inb-ell">{r.title || 'Untitled'}</span>
          <span className="inb-when">{fireLabel(r)}</span>
        </Link>
      ))}
    </div>
  );
}

/** The notification list with its header. Used in the desktop panel and the phone screen. */
function NotificationsBody({ onDone, phone }: { onDone?: () => void; phone?: boolean }) {
  const s = useShell();
  const ui = useUi();
  const list = useNotifications({ limit: 50 });
  const open = useOpenNotification();
  const unread = list.data?.some((n) => !n.read);
  const markAll = () => markRead().catch((err) => ui.toast((err as Error).message));
  return (
    <>
      {!phone && (
        <div className="inb-panel-head">
          <h2>Notifications</h2>
          <button className="btn ghost small" onClick={markAll} disabled={!unread}><CheckCheck size={15} />Mark All as Read</button>
        </div>
      )}
      <div className="inb-notes" role="list">
        {list.isError && <div className="inb-quiet">Notifications can’t load right now. {list.error.message}</div>}
        {list.data?.length === 0 && (
          <div className="inb-empty">
            <Bell size={22} aria-hidden />
            <b>You’re all caught up</b>
            <span>Mentions, replies, assignments and reminders show up here.</span>
          </div>
        )}
        {list.data?.map((n) => <div role="listitem" key={n.id}><NotificationRow n={n} onOpen={(x) => open(x, onDone)} /></div>)}
      </div>
      <div className="inb-section-h">Upcoming reminders</div>
      <UpcomingReminders wid={s.wid} limit={phone ? undefined : 5} onOpen={onDone} />
      {phone && unread && <button className="btn large inb-markall" onClick={markAll}><CheckCheck size={17} />Mark All as Read</button>}
    </>
  );
}

/** Sidebar bell with the unread count; opens the notification panel. */
export function NotificationBell() {
  const count = useNotificationCount();
  const n = count.data?.unread ?? 0;
  return (
    <Popover placement="bottom-start" className="menu inb-panel" trigger={(p, open) => (
      <button className={`icon-btn inb-bell${open ? ' open' : ''}`} aria-label={n ? `Notifications, ${n} unread` : 'Notifications'} title="Notifications" {...p}>
        <Bell size={17} />{n > 0 && <span className="inb-badge corner" aria-hidden>{n > 99 ? '99+' : n}</span>}
      </button>
    )}>
      {(close) => <NotificationsBody onDone={close} />}
    </Popover>
  );
}

/** Phone: notifications as their own screen (from More). */
export function NotificationsScreen() {
  return (
    <>
      <TopBar back here="Notifications" />
      <div className="content"><div className="inb-screen"><NotificationsBody phone /></div></div>
    </>
  );
}

/** Route /p/:pid: links in push notifications and emails carry no workspace, so look it up. */
export function PageRedirect() {
  const { pid = '' } = useParams();
  const page = useQuery({ queryKey: ['page', pid], queryFn: () => get<Page>(`/api/pages/${pid}`), retry: false });
  if (page.isPending) return null;
  return <Navigate to={page.data ? `/w/${page.data.workspaceId}/p/${pid}` : '/'} replace />;
}

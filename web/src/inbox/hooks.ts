import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  ChangeDetail, ChangeSummary, Comment, MailSettings, Notification, PushSubscriptionInfo,
} from '../../../shared/types.ts';
import { ApiFailure, get, patch, post, qc } from '../api.ts';

export interface UpcomingReminder { pageId: string; title: string; icon: string; fireAt: string; occurrence: string }
export interface Mentionables {
  pages: { id: string; title: string; icon: string; path: string }[];
  people: { id: string; name: string; color: string }[];
}

// Newer endpoints may be missing on an older server: fail fast instead of retrying.
const once = { retry: false } as const;

// ---------- Notifications ----------
export const useNotificationCount = () =>
  useQuery({ queryKey: ['notifications', 'count'], queryFn: () => get<{ unread: number }>('/api/notifications/count'), ...once, staleTime: 30_000 });

export const useNotifications = (opts: { unread?: boolean; limit?: number } = {}) =>
  useQuery({
    queryKey: ['notifications', 'list', !!opts.unread, opts.limit ?? 50],
    queryFn: () => get<Notification[]>(`/api/notifications?limit=${opts.limit ?? 50}${opts.unread ? '&unread=1' : ''}`),
    ...once,
  });

export const useReminders = (wid: string, days = 14) =>
  useQuery({ queryKey: ['notifications', 'reminders', wid, days], queryFn: () => get<UpcomingReminder[]>(`/api/workspaces/${wid}/reminders?days=${days}`), ...once, enabled: !!wid });

export async function markRead(ids?: string[]) {
  // Show it read right away; the live event refreshes the real state.
  qc.setQueriesData<Notification[]>({ queryKey: ['notifications', 'list'] }, (old) =>
    old?.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)));
  qc.setQueryData<{ unread: number }>(['notifications', 'count'], (old) =>
    old ? { unread: ids ? Math.max(0, old.unread - ids.length) : 0 } : old);
  await post('/api/notifications/read', ids ? { ids } : {});
  qc.invalidateQueries({ queryKey: ['notifications'] });
}

// ---------- Push and mail ----------
export const usePushDevices = () =>
  useQuery({ queryKey: ['push', 'devices'], queryFn: () => get<PushSubscriptionInfo[]>('/api/push/subscriptions'), ...once });
export const useMailSettings = () =>
  useQuery({ queryKey: ['admin', 'mail'], queryFn: () => get<MailSettings>('/api/admin/mail'), ...once });

// ---------- Comments ----------
export const useComments = (pageId: string, enabled = true) =>
  useQuery({ queryKey: ['comments', pageId], queryFn: () => get<Comment[]>(`/api/pages/${pageId}/comments`), enabled, ...once });

export const searchMentionables = (wid: string, q: string) =>
  get<Mentionables>(`/api/workspaces/${wid}/mentionables?q=${encodeURIComponent(q)}`);

// ---------- Change review ----------
export type ActorFilter = 'ai' | 'all';

export const useChanges = (wid: string, actor: ActorFilter, client: string) =>
  useInfiniteQuery({
    queryKey: ['changes', wid, actor, client],
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => get<ChangeSummary[]>(
      `/api/workspaces/${wid}/changes?actor=${actor}&limit=40${client ? `&client=${encodeURIComponent(client)}` : ''}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
    ),
    getNextPageParam: (last) => (last.length < 40 ? undefined : last[last.length - 1].at),
    ...once,
  });

export const useLatestChanges = (wid: string, limit: number) =>
  useQuery({ queryKey: ['changes', wid, 'latest', limit], queryFn: () => get<ChangeSummary[]>(`/api/workspaces/${wid}/changes?actor=ai&limit=${limit}`), ...once });

export const useChangeDetail = (id: string, enabled: boolean) =>
  useQuery({ queryKey: ['change', id], queryFn: () => get<ChangeDetail>(`/api/changes/${id}`), enabled, ...once });

/** Undo one change. Resolves to 'conflict' when the page changed since and `force` wasn't set. */
export async function undoChange(id: string, force = false): Promise<'ok' | 'conflict'> {
  try {
    await post<ChangeSummary>(`/api/changes/${id}/undo`, force ? { force: true } : {});
    return 'ok';
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 409) return 'conflict';
    throw err;
  }
}

export const undoMany = (ids: string[], force = false) =>
  post<{ undone: string[]; conflicts: string[]; failed: string[] }>('/api/changes/undo', { ids, ...(force ? { force: true } : {}) });

/** After undoing: the change list and every page-shaped cache may be stale. */
export function refreshAfterUndo(wid: string) {
  for (const key of ['changes', 'change', 'page', 'rows', 'tree', 'recent', 'activity', 'trash']) {
    qc.invalidateQueries({ queryKey: key === 'changes' ? [key, wid] : [key] });
  }
}

// ---------- Time zone ----------
/** Once per user and browser: a fresh account still on 'UTC' takes this browser's zone, so reminders fire on time. */
export function syncTimezone(user: { id: string; prefs: { timezone: string } }) {
  const key = `cairn.tzSynced.${user.id}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  let zone = 'UTC';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return; }
  if (user.prefs.timezone !== 'UTC' || zone === 'UTC') return;
  patch('/api/me', { prefs: { timezone: zone } }).then(() => qc.invalidateQueries({ queryKey: ['bootstrap'] })).catch(() => localStorage.removeItem(key));
}

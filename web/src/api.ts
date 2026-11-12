import { QueryClient, useQuery } from '@tanstack/react-query';
import type {
  Activity, AdminOverview, AdminSettings, AdminWorkspace, ApiToken, Bootstrap, Invite, Member, Page,
  PageVersion, RecentPage, Row, SearchHit, TrashItem, Tree, User,
} from '../../shared/types.ts';

export const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);

export const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
});

export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Cairn-Client': clientId };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiFailure('Cairn can’t reach the server. Check your connection and try again.', 0, 'network');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiFailure(data?.error?.message ?? `Something went wrong (${res.status}).`, res.status, data?.error?.code ?? 'error');
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T,>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T,>(path: string) => api<T>('DELETE', path);
export const put = <T,>(path: string) => api<T>('PUT', path, {});

// ---------- Query hooks ----------
export const useBootstrap = () => useQuery({ queryKey: ['bootstrap'], queryFn: () => get<Bootstrap>('/api/bootstrap') });
export const useTree = (wid: string) => useQuery({ queryKey: ['tree', wid], queryFn: () => get<Tree>(`/api/workspaces/${wid}/tree`) });
export const usePage = (id: string | undefined) =>
  useQuery({ queryKey: ['page', id], queryFn: () => get<Page>(`/api/pages/${id}`), enabled: !!id, retry: false });
export const useRows = (id: string | undefined) =>
  useQuery({ queryKey: ['rows', id], queryFn: () => get<Row[]>(`/api/pages/${id}/rows`), enabled: !!id });
export const useRecent = (wid: string) =>
  useQuery({ queryKey: ['recent', wid], queryFn: () => get<RecentPage[]>(`/api/workspaces/${wid}/recent?limit=8`) });
export const useActivity = (wid: string, limit = 12) =>
  useQuery({ queryKey: ['activity', wid, limit], queryFn: () => get<Activity[]>(`/api/workspaces/${wid}/activity?limit=${limit}`) });
export const useTrash = (wid: string) => useQuery({ queryKey: ['trash', wid], queryFn: () => get<TrashItem[]>(`/api/workspaces/${wid}/trash`) });
export const useMembers = (wid: string) => useQuery({ queryKey: ['members', wid], queryFn: () => get<Member[]>(`/api/workspaces/${wid}/members`) });
export const useWsUsers = (wid: string) =>
  useQuery({ queryKey: ['wsusers', wid], queryFn: () => get<{ id: string; name: string; color: string }[]>(`/api/workspaces/${wid}/users`), staleTime: 60_000 });
export const useInvites = (wid: string, enabled: boolean) =>
  useQuery({ queryKey: ['invites', wid], queryFn: () => get<Invite[]>(`/api/workspaces/${wid}/invites`), enabled });
export const useTokens = () => useQuery({ queryKey: ['tokens'], queryFn: () => get<ApiToken[]>('/api/tokens') });
export const useVersions = (id: string, enabled: boolean) =>
  useQuery({ queryKey: ['versions', id], queryFn: () => get<PageVersion[]>(`/api/pages/${id}/versions`), enabled });
export const useAdminOverview = () => useQuery({ queryKey: ['admin', 'overview'], queryFn: () => get<AdminOverview>('/api/admin/overview') });
export const useAdminUsers = () =>
  useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<(User & { workspaces: number })[]>('/api/admin/users') });
export const useAdminWorkspaces = () => useQuery({ queryKey: ['admin', 'workspaces'], queryFn: () => get<AdminWorkspace[]>('/api/admin/workspaces') });
export const useAdminSettings = () => useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<AdminSettings>('/api/admin/settings') });
export const searchPages = (wid: string, q: string) => get<SearchHit[]>(`/api/workspaces/${wid}/search?q=${encodeURIComponent(q)}&limit=12`);

export function invalidateWorkspace(wid: string) {
  for (const key of ['tree', 'recent', 'activity', 'trash']) qc.invalidateQueries({ queryKey: [key, wid] });
}

// ---------- Small helpers ----------
export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

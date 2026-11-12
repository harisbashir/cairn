import { useQuery } from '@tanstack/react-query';
import type { CalendarEvent, HomeLayout, Sticky, StickyColor, Visibility, Widget } from '../../../shared/types.ts';
import { api, del, get, patch, post, qc } from '../api.ts';

export interface WorkspaceStats {
  pages: number;
  databases: number;
  rows: number;
  members: number;
  editsThisWeek: number;
  aiEditsThisWeek: number;
}

export type HomeScope = 'personal' | 'workspace';

export const useHome = (wid: string) =>
  useQuery({ queryKey: ['home', wid], queryFn: () => get<HomeLayout>(`/api/workspaces/${wid}/home`), retry: false });

export const useStickies = (wid: string) =>
  useQuery({ queryKey: ['stickies', wid], queryFn: () => get<Sticky[]>(`/api/workspaces/${wid}/stickies`), retry: false });

export const useStats = (wid: string) =>
  useQuery({ queryKey: ['stats', wid], queryFn: () => get<WorkspaceStats>(`/api/workspaces/${wid}/stats`), retry: false });

export const useCalendarEvents = (wid: string, from: string, to: string) =>
  useQuery({
    queryKey: ['calendar-events', wid, from, to],
    queryFn: () => get<CalendarEvent[]>(`/api/workspaces/${wid}/calendar-events?from=${from}&to=${to}`),
    retry: false,
  });

export async function saveHome(wid: string, scope: HomeScope, widgets: Widget[]): Promise<HomeLayout> {
  const layout = await api<HomeLayout>('PUT', `/api/workspaces/${wid}/home?scope=${scope}`, { widgets });
  qc.setQueryData(['home', wid], layout);
  return layout;
}

export async function resetHome(wid: string): Promise<HomeLayout> {
  const layout = await del<HomeLayout>(`/api/workspaces/${wid}/home?scope=personal`);
  qc.setQueryData(['home', wid], layout);
  return layout;
}

// ---------- Sticky notes ----------
// The list is patched in the cache right away so typing, colours and reordering feel instant.

const setStickies = (wid: string, fn: (list: Sticky[]) => Sticky[]) =>
  qc.setQueryData<Sticky[]>(['stickies', wid], (old) => fn(old ?? []));

export const refetchStickies = (wid: string) => qc.invalidateQueries({ queryKey: ['stickies', wid] });

export async function createSticky(wid: string, body: { text?: string; color?: StickyColor; visibility?: Visibility }): Promise<Sticky> {
  const note = await post<Sticky>(`/api/workspaces/${wid}/stickies`, body);
  setStickies(wid, (list) => [note, ...list.filter((n) => n.id !== note.id)]);
  return note;
}

export async function updateSticky(
  wid: string, id: string, body: { text?: string; color?: StickyColor; visibility?: Visibility; afterId?: string | null },
): Promise<Sticky> {
  const { afterId, ...fields } = body;
  setStickies(wid, (list) => list.map((n) => (n.id === id ? { ...n, ...fields } : n)));
  const note = await patch<Sticky>(`/api/stickies/${id}`, body);
  setStickies(wid, (list) => list.map((n) => (n.id === id ? { ...note, text: n.text } : n)));
  return note;
}

export function moveStickyLocally(wid: string, id: string, afterId: string | null) {
  setStickies(wid, (list) => {
    const note = list.find((n) => n.id === id);
    if (!note) return list;
    const rest = list.filter((n) => n.id !== id);
    const at = afterId === null ? 0 : rest.findIndex((n) => n.id === afterId) + 1;
    return [...rest.slice(0, at), note, ...rest.slice(at)];
  });
}

export async function deleteSticky(wid: string, id: string) {
  setStickies(wid, (list) => list.filter((n) => n.id !== id));
  await del(`/api/stickies/${id}`);
}

import { useQuery } from '@tanstack/react-query';
import type {
  BackupRun, BackupSettings, CalendarFeed, ConnectedApp, ExternalCalendar, Job,
} from '../../../shared/types.ts';
import { get } from '../api.ts';

export interface StoredFile { id: string; name: string; url: string; mime: string; size: number; createdAt: string; createdByName: string }

// Newer endpoints may be missing on an older server: fail fast instead of retrying.
const once = { retry: false } as const;

export const useConnectedApps = () =>
  useQuery({ queryKey: ['connected-apps'], queryFn: () => get<ConnectedApp[]>('/api/connected-apps'), ...once });
export const useCalendars = (wid: string) =>
  useQuery({ queryKey: ['calendars', wid], queryFn: () => get<ExternalCalendar[]>(`/api/workspaces/${wid}/calendars`), ...once });
export const useCalendarFeed = (wid: string) =>
  useQuery({ queryKey: ['calendar-feed', wid], queryFn: () => get<CalendarFeed>(`/api/workspaces/${wid}/calendar-feed`), ...once });
export const useWorkspaceFiles = (wid: string) =>
  useQuery({ queryKey: ['files', wid], queryFn: () => get<StoredFile[]>(`/api/workspaces/${wid}/files`), ...once });
export const useBackupSettings = () =>
  useQuery({ queryKey: ['admin', 'backup-settings'], queryFn: () => get<BackupSettings>('/api/admin/backups/settings'), ...once });
export const useBackupRuns = () =>
  useQuery({
    queryKey: ['admin', 'backups'], queryFn: () => get<BackupRun[]>('/api/admin/backups'), ...once,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 2000 : false),
  });
export const useJob = (id: string | null) =>
  useQuery({
    queryKey: ['job', id], queryFn: () => get<Job>(`/api/jobs/${id}`), enabled: !!id, ...once,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 1500),
  });

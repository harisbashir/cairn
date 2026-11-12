import { CheckCircle2, CircleAlert, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Role } from '../../../shared/types.ts';
import { ApiFailure, invalidateWorkspace } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { CopyButton, useUi } from '../ui.tsx';
import { useJob } from './hooks.ts';

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control, including deleting the workspace', admin: 'Manages members and settings', member: 'Creates and edits pages', viewer: 'Reads only',
};

/** Runs an action, toasting its error (or the success message). Resolves to whether it worked. */
export function useAct() {
  const ui = useUi();
  return async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); if (done) ui.toast(done); return true; } catch (err) { ui.toast((err as Error).message); return false; }
  };
}

export function Code({ text, label }: { text: string; label?: string }) {
  return <div className="codebox">{text}<CopyButton text={text} label={label} /></div>;
}

export function fmtBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A calm inline message for data that couldn't load, with a way to try again. */
export function LoadNote({ what, error, retry }: { what: string; error: Error | null; retry?: () => void }) {
  const missing = error instanceof ApiFailure && error.status === 404;
  return (
    <div className="st-note" role="status">
      <CircleAlert size={16} aria-hidden />
      <span className="grow">
        {missing ? `This server can’t show ${what} yet. It may need an update to the latest version of Cairn.` : `Cairn couldn’t load ${what}. ${error?.message ?? ''}`}
      </span>
      {retry && <button className="btn small" onClick={retry}>Try Again</button>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="subtle st-loading" role="status"><Loader2 size={15} className="st-spin" aria-hidden />Loading {what}…</p>;
}

/** Follows a background job (import or export) until it finishes. */
export function JobProgress({ id, onOpen, onFinish }: { id: string; onOpen: () => void; onFinish?: () => void }) {
  const s = useShell();
  const job = useJob(id);
  const status = job.data?.status;
  const finished = useRef(false);
  useEffect(() => {
    if (finished.current || !status || status === 'running') return;
    finished.current = true;
    invalidateWorkspace(s.wid);
    onFinish?.();
  }, [status, s.wid, onFinish]);

  if (job.isError) return <LoadNote what="the progress of this job" error={job.error} retry={() => job.refetch()} />;
  const j = job.data;
  if (!j || j.status === 'running') {
    return (
      <div className="st-job" role="status" aria-live="polite">
        <Loader2 size={16} className="st-spin" aria-hidden />
        <span className="grow">{j?.progress || 'Starting…'}</span>
      </div>
    );
  }
  if (j.status === 'failed') {
    return (
      <div className="st-job st-job-failed" role="alert">
        <CircleAlert size={16} aria-hidden />
        <span className="grow"><b>That didn’t work.</b> {j.error ?? 'The job stopped without saying why.'}</span>
      </div>
    );
  }
  const titleOf = (pid: string) => s.tree?.nodes.find((n) => n.id === pid);
  const ids = j.result?.pageIds ?? [];
  return (
    <div className="st-job st-job-done" role="status">
      <CheckCircle2 size={16} aria-hidden />
      <div className="grow st-job-body">
        <b>{j.kind === 'notion-export' ? 'Sent to Notion.' : ids.length ? `Imported ${ids.length} ${ids.length === 1 ? 'page' : 'pages'}.` : 'Finished.'}</b>
        {ids.length > 0 && (
          <ul className="st-links">
            {ids.slice(0, 12).map((pid) => {
              const n = titleOf(pid);
              return <li key={pid}><Link to={`/w/${s.wid}/p/${pid}`} onClick={onOpen}><FileText size={14} aria-hidden />{n ? (n.title || 'Untitled') : 'Open imported page'}</Link></li>;
            })}
            {ids.length > 12 && <li className="subtle">and {ids.length - 12} more in the sidebar</li>}
          </ul>
        )}
        {j.result?.url && <a href={j.result.url} target="_blank" rel="noreferrer" className="st-ext">Open in Notion<ExternalLink size={13} aria-hidden /></a>}
      </div>
    </div>
  );
}

/** A titled group with optional trailing actions in the heading. */
export function Group({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <h3 className="st-h3">{title}{actions && <span className="st-h3-actions">{actions}</span>}</h3>
      {children}
    </>
  );
}

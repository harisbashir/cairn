import type { Job } from '../../shared/types.ts';
import { id, now } from './db.ts';
import { fail } from './common.ts';

/** Ephemeral jobs contain no credentials; task closures are released on completion. */
export class Jobs {
  private jobs = new Map<string, { owner: string; workspaceId?: string; job: Job; expires: number }>();
  constructor(private clock = Date.now) {}
  purge() { for (const [key, value] of this.jobs) if (value.expires <= this.clock()) this.jobs.delete(key); }
  get(key: string, owner: string, workspaceId?: string | null): Job {
    this.purge();
    const entry = this.jobs.get(key);
    if (!entry || entry.owner !== owner || (workspaceId && entry.workspaceId !== workspaceId)) return fail(404, 'Job not found.');
    return structuredClone(entry.job);
  }
  start(owner: string, kind: Job['kind'], task: (progress: (message: string) => void) => Promise<NonNullable<Job['result']>>, workspaceId?: string): Job {
    this.purge();
    const job: Job = { id: id(), kind, status: 'running', progress: 'Starting…', error: null, result: null, startedAt: now(), finishedAt: null };
    const entry = { owner, workspaceId, job, expires: this.clock() + 3600000 };
    this.jobs.set(job.id, entry);
    const expire = () => { if (this.jobs.get(job.id) === entry && entry.expires <= this.clock()) this.jobs.delete(job.id); };
    let timer = setTimeout(expire,3600000); timer.unref();
    // A microtask starts work after the response shape has been captured.
    void Promise.resolve().then(() => task(message => { job.progress = message; })).then(result => {
      job.status = 'done'; job.result = result; job.progress = 'Done';
    }, () => { job.status = 'failed'; job.error = 'The import or export failed. Check the source and try again.'; }).finally(() => {
      job.finishedAt = now(); entry.expires = this.clock() + 3600000;
      clearTimeout(timer); timer = setTimeout(expire,3600000); timer.unref();
    });
    return structuredClone(job);
  }
}

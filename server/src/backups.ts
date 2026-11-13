import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, writeSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { BackupDestination, BackupSettings, BackupRun } from '../../shared/types.ts';
import { Store, id, now } from './db.ts';
import { appVersion, body, fail, type Env } from './common.ts';
import type { Pages } from './pages.ts';

const runFile = promisify(execFile);
const backupName = /^cairn-backup-\d{8}-\d{6}\.zip$/;
export const backupVersion = appVersion;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Backup failed.';
export function rcloneAvailable(): boolean { const result = spawnSync('rclone', ['version'], { stdio: 'ignore', timeout: 5000 }); return !result.error && result.status === 0; }
function defaultSettings(): BackupSettings { return { enabled: false, frequency: 'daily', hour: 3, weekday: 0, keep: 7, destinations: [], rcloneAvailable: rcloneAvailable() }; }
const destinationSchema = z.object({ id: z.string().min(1).max(100), type: z.enum(['local', 'webdav', 'rclone']), name: z.string().min(1).max(200), config: z.record(z.string(), z.string().max(1024 * 1024)), hasSecret: z.boolean().optional().default(false) });
const settingsSchema = z.object({ enabled: z.boolean(), frequency: z.enum(['hourly', 'daily', 'weekly']), hour: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6), keep: z.number().int().min(1).max(1000), destinations: z.array(destinationSchema).max(20), rcloneAvailable: z.boolean().optional() });

const LOCK_TOKEN = randomUUID();
/** Store an advisory process lock only for the running HTTP server, not short-lived CLI commands. */
export function serverIsRunning(dataDir: string): boolean {
  const lock = join(dataDir, 'cairn.server.lock');
  if (!existsSync(lock)) return false;
  const [pidText, token] = readFileSync(lock, 'utf8').trim().split(' ');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  // Our PID with another run's token: a previous run with the same PID left the lock (container restarts are PID 1 both times).
  if (pid === process.pid) return token === LOCK_TOKEN;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== 'ESRCH'; }
}
export function acquireServerLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'cairn.server.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    if (serverIsRunning(dataDir)) throw new Error('A Cairn server already holds this database.');
    rmSync(lock, { force: true }); fd = openSync(lock, 'wx', 0o600);
  }
  const mark = `${process.pid} ${LOCK_TOKEN}`;
  try { writeFileSync(fd, mark); } finally { closeSync(fd); }
  return () => { if (existsSync(lock) && readFileSync(lock, 'utf8').trim() === mark) rmSync(lock, { force: true }); };
}

/** ZIP entries are fed a chunk at a time; uploaded file bodies are never accumulated in memory. */
export async function createBackup(store: Store, output: string): Promise<string> {
  const target = resolve(output), data = resolve(store.dataDir);
  if ([join(data, 'cairn.db'), join(data, 'cairn.db-wal'), join(data, 'cairn.db-shm')].includes(target) || target.startsWith(join(data, 'files') + sep)) throw new Error('The backup output must be outside the database and uploaded files.');
  const temporary = mkdtempSync(join(store.dataDir, '.backup-'));
  let fd: number | undefined;
  let outputOpened = false;
  try {
    const snapshot = join(temporary, 'cairn.db');
    store.db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    const db = new DatabaseSync(snapshot, { readOnly: true });
    let counts: Record<string, number>;
    try { counts = Object.fromEntries(['users', 'workspaces', 'pages', 'files'].map(table => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)])); }
    finally { db.close(); }
    fd = openSync(output, 'w', 0o600); outputOpened = true;
    let zipError: Error | undefined;
    const zip = new Zip((error, chunk) => { if (error) { zipError = error; return; } writeSync(fd!, chunk); });
    async function addFile(path: string, name: string) {
      const entry = new ZipPassThrough(name); zip.add(entry);
      for await (const chunk of createReadStream(path)) { if (zipError) throw zipError; entry.push(new Uint8Array(chunk as Buffer), false); }
      entry.push(new Uint8Array(), true);
    }
    await addFile(snapshot, 'cairn.db');
    async function addDirectory(path: string, prefix: string): Promise<void> {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await addDirectory(join(path, entry.name), `${prefix}${entry.name}/`);
        else if (entry.isFile()) await addFile(join(path, entry.name), `${prefix}${entry.name}`);
      }
    }
    await addDirectory(join(store.dataDir, 'files'), 'files/');
    const manifest = new ZipPassThrough('manifest.json'); zip.add(manifest);
    manifest.push(strToU8(JSON.stringify({ version: backupVersion, createdAt: now(), counts })), true);
    zip.end(); if (zipError) throw zipError;
    closeSync(fd); fd = undefined;
    return output;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (outputOpened) rmSync(output, { force: true }); throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function cleanDestination(destination: BackupDestination): BackupDestination {
  const config = { ...destination.config };
  let hasSecret = false;
  for (const key of ['password', 'config']) if (key in config) { hasSecret ||= !!config[key]; config[key] = ''; }
  return { ...destination, config, hasSecret };
}
function validateDestination(destination: BackupDestination) {
  if (destination.type === 'webdav') {
    let url: URL; try { url = new URL(destination.config.url); } catch { return fail(400, 'A valid WebDAV URL is required.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(400, 'Use an HTTP or HTTPS WebDAV URL without credentials, query or fragment.');
  }
  if (destination.type === 'rclone' && (!destination.config.remote || destination.config.remote.startsWith('-') || !destination.config.remote.includes(':') || !destination.config.config)) fail(400, 'An rclone remote and configuration are required.');
}
function periodStart(settings: BackupSettings, date: Date): Date {
  const start = new Date(date);
  start.setMinutes(0, 0, 0);
  if (settings.frequency !== 'hourly') {
    start.setHours(settings.hour);
    if (start > date) start.setDate(start.getDate() - 1);
    if (settings.frequency === 'weekly') start.setDate(start.getDate() - (start.getDay() - settings.weekday + 7) % 7);
  }
  return start;
}
function filename(date: Date): string {
  return `cairn-backup-${date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.zip`;
}

export class BackupService {
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(public store: Store, private fetchImpl: typeof fetch = fetch) {}
  settings(): BackupSettings {
    const saved = this.store.get('backupSettings', 'instance');
    const { id: ignored, ...settings } = saved ?? {};
    return { ...defaultSettings(), ...settings, destinations: (settings.destinations ?? []).map(cleanDestination), rcloneAvailable: rcloneAvailable() };
  }
  private storedSettings(): BackupSettings { return { ...defaultSettings(), ...this.store.get('backupSettings', 'instance') }; }
  private mergeDestination(destination: BackupDestination): BackupDestination {
    const old = this.storedSettings().destinations.find(d => d.id === destination.id && d.type === destination.type);
    const config = { ...destination.config };
    for (const key of ['password', 'config']) if (!config[key] && old?.config[key]) config[key] = old.config[key];
    const merged = { ...destination, config }; validateDestination(merged); return merged;
  }
  saveSettings(input: unknown): BackupSettings {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) fail(400, 'Invalid backup settings.');
    const settings = parsed.data;
    if (new Set(settings.destinations.map(d => d.id)).size !== settings.destinations.length) fail(400, 'Destination IDs must be unique.');
    if (settings.enabled && !settings.destinations.length) fail(400, 'Add a destination before enabling backups.');
    this.store.put('backupSettings', { id: 'instance', ...settings, destinations: settings.destinations.map(d => this.mergeDestination(d)) });
    return this.settings();
  }
  private pathFor(run: any): string | undefined {
    if (run.fileName && backupName.test(run.fileName)) { const path = join(this.store.dataDir, 'backups', run.fileName); if (existsSync(path)) return path; }
  }
  path(runId: string): string | undefined { const run = this.store.get('backupRuns', runId); return run ? this.pathFor(run) : undefined; }
  list(): BackupRun[] {
    return this.store.all('backupRuns').reverse().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50).map(run => {
      const { fileName: ignored, ...value } = run;
      return { ...value, downloadable: !!this.pathFor(run) } as BackupRun;
    });
  }
  start(trigger: 'manual' | 'schedule' = 'manual', date = new Date()): BackupRun {
    if (this.running) fail(409, 'A backup is already running.');
    const settings = this.storedSettings();
    if (!settings.destinations.length) fail(400, 'Configure at least one backup destination.');
    const run: BackupRun = { id: id(), startedAt: date.toISOString(), finishedAt: null, status: 'running', sizeBytes: 0, trigger, results: [], downloadable: false };
    this.store.put('backupRuns', run);
    const oldest = this.store.all('backupRuns').reverse().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(50);
    for (const old of oldest) this.store.remove('backupRuns', old.id);
    this.running = this.perform(run, settings).catch(() => {
      // Completion persistence can itself fail; detached jobs must not reject.
      run.status = 'failed'; run.finishedAt = now();
    }).finally(() => { this.running = undefined; });
    return run;
  }
  async waitForIdle(): Promise<void> { await this.running; }
  tick(date = new Date()): void {
    if (this.running) return;
    const settings = this.storedSettings(); if (!settings.enabled || !settings.destinations.length) return;
    const start = periodStart(settings, date).toISOString();
    if (this.store.all<BackupRun>('backupRuns').some(run => run.trigger === 'schedule' && run.startedAt >= start)) return;
    this.start('schedule', date);
  }
  schedule(): void { if (!this.timer) { this.timer = setInterval(() => { try { this.tick(); } catch { /* A future tick retries if the database was temporarily unavailable. */ } }, 60_000); this.timer.unref(); } }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async perform(run: BackupRun, settings: BackupSettings): Promise<void> {
    let temp: string | undefined;
    let localName: string | undefined;
    let archiveName: string | undefined;
    try {
      temp = mkdtempSync(join(this.store.dataDir, '.backup-run-'));
      let time = new Date(run.startedAt); let name = filename(time);
      const previousNames = new Set(this.store.all('backupRuns').map(previous => previous.fileName));
      while (previousNames.has(name) || existsSync(join(this.store.dataDir, 'backups', name))) { time = new Date(time.getTime() + 1000); name = filename(time); }
      archiveName = name;
      const path = await createBackup(this.store, join(temp, name));
      run.sizeBytes = statSync(path).size;
      for (const destination of settings.destinations) {
        try {
          if (destination.type === 'local') {
            const folder = join(this.store.dataDir, 'backups'); mkdirSync(folder, { recursive: true }); copyFileSync(path, join(folder, name)); localName = name;
            for (const old of readdirSync(folder).filter(n => backupName.test(n)).sort().reverse().slice(settings.keep)) unlinkSync(join(folder, old));
          } else await this.remoteBackup(destination, path, name, settings.keep);
          run.results.push({ destinationId: destination.id, name: destination.name, ok: true, message: 'Backup saved.' });
        } catch (error) { run.results.push({ destinationId: destination.id, name: destination.name, ok: false, message: this.safeError(error, destination) }); }
      }
      run.status = run.results.every(result => result.ok) ? 'done' : 'failed';
    } catch { run.status = 'failed'; run.results.push({ destinationId: '', name: 'Backup', ok: false, message: 'Could not create the backup archive.' }); }
    finally {
      try { if (temp) rmSync(temp, { recursive: true, force: true }); }
      catch { run.status = 'failed'; run.results.push({ destinationId: '', name: 'Backup', ok: false, message: 'Could not remove the temporary backup files.' }); }
      run.finishedAt = now(); run.downloadable = !!localName;
      this.store.put('backupRuns', { ...run, ...(archiveName ? { fileName: archiveName } : {}) });
    }
  }
  private safeError(error: unknown, destination: BackupDestination): string {
    const message = errorMessage(error);
    // Remote clients and child processes may include credentials in arbitrary errors.
    // Only expose messages assembled here, never transport errors or command stderr.
    if (destination.type !== 'local') {
      if (/^WebDAV (?:MKCOL|PUT|PROPFIND|DELETE) failed \(HTTP \d{3}\)\.$/.test(message)) return message;
      if (message === 'The rclone command failed. Check the remote and configuration.') return message;
      return 'Could not access the backup destination. Check its address and credentials.';
    }
    return 'Could not write the backup destination.';
  }
  private async dav(destination: BackupDestination, method: string, name = '', path?: string): Promise<Response> {
    const base = destination.config.url.replace(/\/+$/, '') + '/';
    const headers: Record<string, string> = { Authorization: 'Basic ' + Buffer.from(`${destination.config.username ?? ''}:${destination.config.password ?? ''}`).toString('base64') };
    if (method === 'PROPFIND') { headers.Depth = '1'; headers['Content-Type'] = 'application/xml'; }
    const stream = path ? createReadStream(path, { fd: openSync(path, 'r') }) : undefined;
    try {
      const result = await this.fetchImpl(base + encodeURIComponent(name), { method, headers, signal: AbortSignal.timeout(120_000), ...(stream ? { body: stream as any, duplex: 'half' } : {}) } as RequestInit);
      if (!result.ok && !(method === 'MKCOL' && result.status === 405)) throw new Error(`WebDAV ${method} failed (HTTP ${result.status}).`);
      return result;
    } finally { stream?.destroy(); }
  }
  private async withRclone<T>(destination: BackupDestination, fn: (command: (args: string[]) => Promise<string>) => Promise<T>): Promise<T> {
    const temp = mkdtempSync(join(this.store.dataDir, '.rclone-'));
    const config = join(temp, 'rclone.conf'); writeFileSync(config, destination.config.config, { mode: 0o600 });
    try { return await fn(async args => { try { const { stdout } = await runFile('rclone', [...args, '--config', config], { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }); return stdout; } catch { throw new Error('The rclone command failed. Check the remote and configuration.'); } }); }
    finally { rmSync(temp, { recursive: true, force: true }); }
  }
  private async remoteBackup(destination: BackupDestination, path: string, name: string, keep: number) {
    if (destination.type === 'webdav') {
      await this.dav(destination, 'MKCOL'); await this.dav(destination, 'PUT', name, path);
      const response = await this.dav(destination, 'PROPFIND');
      const xml = await response.text();
      const names = [...xml.matchAll(/<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/gi)].map(match => {
        try { return basename(decodeURIComponent(match[1].replace(/&amp;/g, '&'))); } catch { return ''; }
      }).filter(value => backupName.test(value));
      // Some providers' listing may lag the just-completed PUT.
      names.push(name);
      for (const old of [...new Set(names)].sort().reverse().slice(keep)) await this.dav(destination, 'DELETE', old);
    } else {
      await this.withRclone(destination, async command => {
        const remote = destination.config.remote.replace(/\/+$/, '');
        await command(['copyto', path, `${remote}/${name}`]);
        const names = (await command(['lsf', remote, '--files-only', '--max-depth', '1'])).split(/\r?\n/).filter(value => backupName.test(value)); names.push(name);
        for (const old of [...new Set(names)].sort().reverse().slice(keep)) await command(['deletefile', `${remote}/${old}`]);
      });
    }
  }
  async testDestination(input: unknown): Promise<{ ok: boolean; message: string }> {
    const parsed = destinationSchema.safeParse(input); if (!parsed.success) fail(400, 'Invalid backup destination.');
    const destination = this.mergeDestination(parsed.data);
    const name = `cairn-test-${id()}.txt`;
    const temp = mkdtempSync(join(this.store.dataDir, '.backup-test-')); const path = join(temp, name); writeFileSync(path, 'Cairn backup destination test\n', { mode: 0o600 });
    try {
      if (destination.type === 'local') { const dir = join(this.store.dataDir, 'backups'); mkdirSync(dir, { recursive: true }); const target = join(dir, name); try { copyFileSync(path, target); } finally { rmSync(target, { force: true }); } }
      else if (destination.type === 'webdav') { await this.dav(destination, 'MKCOL'); try { await this.dav(destination, 'PUT', name, path); } finally { await this.dav(destination, 'DELETE', name); } }
      else await this.withRclone(destination, async command => { const target = destination.config.remote.replace(/\/+$/, '') + '/' + name; try { await command(['copyto', path, target]); } finally { await command(['deletefile', target]); } });
      return { ok: true, message: 'Destination is writable. Test file removed.' };
    } catch (error) { return { ok: false, message: this.safeError(error, destination) }; }
    finally { rmSync(temp, { recursive: true, force: true }); }
  }
}

export function registerBackups(app: Hono<Env>, pages: Pages, fetchImpl: typeof fetch = fetch): BackupService {
  const backups = new BackupService(pages.s, fetchImpl);
  app.use('/api/admin/backups*', async (c, next) => {
    const actor = c.get('actor');
    if (!actor?.user.isAdmin || actor.workspaceId || actor.access === 'read') fail(403, 'Unrestricted instance administrator access is required.');
    await next();
  });
  app.get('/api/admin/backups/settings', c => c.json(backups.settings()));
  app.put('/api/admin/backups/settings', async c => c.json(backups.saveSettings(await body(c, settingsSchema))));
  app.post('/api/admin/backups/run', c => c.json(backups.start()));
  app.get('/api/admin/backups', c => c.json(backups.list()));
  app.post('/api/admin/backups/test', async c => { const value = await body(c, z.object({ destination: destinationSchema })); return c.json(await backups.testDestination(value.destination)); });
  app.get('/api/admin/backups/:id/download', c => {
    const path = backups.path(c.req.param('id')) ?? fail(404, 'No local copy of this backup is available.');
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${basename(path)}"`, 'Content-Length': String(statSync(path).size), 'Cache-Control': 'no-store' } });
  });
  backups.schedule(); return backups;
}

import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/common.ts';
import { ApiException } from '../src/common.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { Store } from '../src/db.ts';
import { BackupService, acquireServerLock, createBackup, registerBackups } from '../src/backups.ts';
import { restoreBackup, runCli } from '../src/cli.ts';
import { passwordMatches } from '../src/auth.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const services: BackupService[] = [];
function setup() { const dir = mkdtempSync(join(tmpdir(), 'cairn-backup-test-')); dirs.push(dir); const s = new Store(dir); stores.push(s); return { dir, s }; }
function service(s: Store, fetchImpl?: typeof fetch) { const b = new BackupService(s, fetchImpl); services.push(b); return b; }
const local = { id: 'local', name: 'Local', type: 'local' as const, config: {}, hasSecret: false };
afterEach(() => { for (const b of services.splice(0)) b.close(); for (const s of stores.splice(0)) { try { s.close(); } catch {} } for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

describe('instance backups', () => {
  it('creates a consistent snapshot, uploaded files and manifest, and CLI restore keeps the old database', async () => {
    const { dir, s } = setup();
    s.put('users', { id: 'before', name: 'Before' });
    mkdirSync(join(dir, 'files', 'nested')); writeFileSync(join(dir, 'files', 'nested', 'hello.txt'), 'hello');
    const output = join(dir, 'backup.zip');
    await createBackup(s, output);
    const entries = unzipSync(readFileSync(output));
    expect(Object.keys(entries)).toEqual(expect.arrayContaining(['cairn.db', 'manifest.json', 'files/nested/hello.txt']));
    expect(strFromU8(entries['files/nested/hello.txt'])).toBe('hello');
    expect(JSON.parse(strFromU8(entries['manifest.json'])).counts.users).toBe(1);
    expect(JSON.parse(strFromU8(entries['manifest.json'])).version).toBe('0.3.0');
    s.put('users', { id: 'after', name: 'After' }); s.close();
    await restoreBackup(output, dir);
    const restored = new Store(dir); stores.push(restored);
    expect(restored.get('users', 'before')).toBeDefined(); expect(restored.get('users', 'after')).toBeUndefined();
    expect(existsSync(join(dir, 'cairn.db.before-restore'))).toBe(true);
    expect(readFileSync(join(dir, 'files', 'nested', 'hello.txt'), 'utf8')).toBe('hello');
  });
  it('enforces local retention, reports downloads accurately, and keeps only 50 records', async () => {
    const { dir, s } = setup(); const b = service(s);
    b.saveSettings({ ...b.settings(), destinations: [local], keep: 1 });
    const first = b.start(); await b.waitForIdle();
    expect(b.list()[0].status).toBe('done'); expect(b.path(first.id)).toBeTruthy();
    b.start(); await b.waitForIdle();
    expect(readdirSync(join(dir, 'backups')).filter(x => x.endsWith('.zip'))).toHaveLength(1);
    expect(b.list().find(r => r.id === first.id)?.downloadable).toBe(false);
    for (let i = 0; i < 60; i++) s.put('backupRuns', { id: `old${i}`, startedAt: '2000-01-01', status: 'done', finishedAt: null, results: [], sizeBytes: 0, trigger: 'manual', downloadable: false });
    b.start(); await b.waitForIdle(); expect(b.list()).toHaveLength(50);
  });
  it('keeps secrets write-only and uploads, lists, and deletes only matching WebDAV backup names', async () => {
    const { dir, s } = setup(); const requests: { url: string; method: string }[] = [];
    const mock = (async (url: any, init: any) => { requests.push({ url: String(url), method: init.method });
      if (init.method === 'PROPFIND') return new Response('<d:multistatus><d:href>/backups/cairn-backup-20000101-000000.zip</d:href><d:href>/backups/unrelated.zip</d:href></d:multistatus>', { status: 207 });
      return new Response(null, { status: init.method === 'MKCOL' ? 405 : 201 });
    }) as typeof fetch;
    const b = service(s, mock);
    const destination = { id: 'dav', name: 'DAV', type: 'webdav' as const, hasSecret: false, config: { url: 'https://dav.example/backups/', username: 'user', password: 'secret' } };
    b.saveSettings({ ...b.settings(), destinations: [destination], keep: 1 });
    expect(b.settings().destinations[0].config.password).toBe(''); expect(b.settings().destinations[0].hasSecret).toBe(true);
    b.saveSettings({ ...b.settings(), destinations: [{ ...destination, config: { ...destination.config, password: '' } }] });
    expect(s.get('backupSettings', 'instance').destinations[0].config.password).toBe('secret');
    b.start(); await b.waitForIdle(); expect(b.list()[0].status).toBe('done');
    expect(requests.some(r => r.method === 'PUT')).toBe(true);
    expect(requests.some(r => r.method === 'DELETE' && r.url.endsWith('20000101-000000.zip'))).toBe(true);
    expect(requests.some(r => r.url.endsWith('unrelated.zip'))).toBe(false);
    expect(readdirSync(dir).some(x => x.startsWith('.backup-'))).toBe(false);
    expect(b.list()[0].downloadable).toBe(false);
    expect((await b.testDestination({ ...destination, config: { ...destination.config, password: '' } })).ok).toBe(true);
  });
  it('schedules due runs once per period and prevents overlapping runs', async () => {
    const { s } = setup(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const b = service(s, (async () => { await waiting; return new Response(null, { status: 201 }); }) as typeof fetch);
    b.saveSettings({ ...b.settings(), enabled: true, frequency: 'daily', hour: 3, destinations: [{ id: 'dav', name: 'DAV', type: 'webdav', hasSecret: false, config: { url: 'https://dav.example/' } }] });
    const date = new Date(2026, 1, 3, 3, 1);
    b.tick(date); expect(b.list()).toHaveLength(1); expect(() => b.start()).toThrow();
    b.tick(date); expect(b.list()).toHaveLength(1); release(); await b.waitForIdle();
    b.tick(new Date(2026, 1, 3, 4, 1)); expect(b.list()).toHaveLength(1);
    b.tick(new Date(2026, 1, 4, 4, 1)); await b.waitForIdle(); expect(b.list()).toHaveLength(2);
  });
  it.each([
    { frequency: 'hourly', first: new Date(2027, 0, 3, 4), same: new Date(2027, 0, 3, 4, 59), next: new Date(2027, 0, 3, 5) },
    { frequency: 'weekly', first: new Date(2027, 0, 3, 4), same: new Date(2027, 0, 9, 23), next: new Date(2027, 0, 10, 4) },
  ] as const)('schedules $frequency backups once in each due period', async ({ frequency, first, same, next }) => {
    const { s } = setup(); const b = service(s);
    b.saveSettings({ ...b.settings(), enabled: true, frequency, hour: 3, weekday: 0, destinations: [local] });
    b.tick(first); await b.waitForIdle(); expect(b.list()).toHaveLength(1);
    b.tick(same); await b.waitForIdle(); expect(b.list()).toHaveLength(1);
    b.tick(next); await b.waitForIdle(); expect(b.list()).toHaveLength(2);
  });
  it('records failed uploads without performing retention and still saves successful destinations', async () => {
    const { s } = setup(); const methods: string[] = [];
    const b = service(s, (async (_url: any, init: any) => { methods.push(init.method); return new Response(null, { status: init.method === 'PUT' ? 500 : 201 }); }) as typeof fetch);
    b.saveSettings({ ...b.settings(), destinations: [local, { id: 'dav', type: 'webdav', name: 'Remote', config: { url: 'https://dav.example/' }, hasSecret: false }] });
    b.start(); await b.waitForIdle();
    const run = b.list()[0]; expect(run.status).toBe('failed'); expect(run.downloadable).toBe(true);
    expect(run.results.map(result => result.ok)).toEqual([true, false]);
    expect(methods).toEqual(['MKCOL', 'PUT']);
  });
  it('CLI creates users, resets passwords, reindexes and refuses live server restore', async () => {
    const { dir, s } = setup(); s.close();
    await runCli(['create-user', '--email', 'ADMIN@example.com', '--name', 'Admin', '--password', 'password1', '--admin'], { dataDir: dir });
    await runCli(['reset-password', '--email', 'admin@example.com', '--password', 'password2'], { dataDir: dir });
    const check = new Store(dir); stores.push(check);
    expect(check.all('users')[0].isAdmin).toBe(true); expect(passwordMatches(check.all('users')[0], 'password2')).toBe(true);
    check.db.exec("INSERT INTO search VALUES('bad','bad','bad')"); check.close();
    await runCli(['reindex'], { dataDir: dir });
    await runCli(['backup', '--out', join(dir, 'cli.zip')], { dataDir: dir });
    const unlock = acquireServerLock(dir);
    await expect(restoreBackup(join(dir, 'cli.zip'), dir)).rejects.toThrow(/server/i);
    await restoreBackup(join(dir, 'cli.zip'), dir, true); unlock();
    const db = new Store(dir); stores.push(db); expect(db.db.prepare('SELECT * FROM search').all()).toHaveLength(0);
  });
  it('rejects duplicate destination IDs and hides arbitrary remote errors containing encoded secrets', async () => {
    const { s } = setup(); const encoded = Buffer.from('user:secret').toString('base64');
    const b = service(s, (async () => { throw new Error('Authorization: Basic ' + encoded + '; password=secret'); }) as typeof fetch);
    expect(() => b.saveSettings({ ...b.settings(), destinations: [local, local] })).toThrow(/unique/i);
    const destination = { id: 'dav', name: 'DAV', type: 'webdav' as const, hasSecret: false, config: { url: 'https://dav.example/', username: 'user', password: 'secret' } };
    const result = await b.testDestination(destination); expect(result.ok).toBe(false);
    expect(result.message).not.toContain('secret'); expect(result.message).not.toContain(encoded);
  });
  it('admin endpoints reject scoped and read tokens and stream local downloads', async () => {
    const { s } = setup(); let actor: any = { user: { id: 'admin', isAdmin: true }, actorType: 'user', clientId: null };
    const app = new Hono<Env>();
    app.onError((error, c) => error instanceof ApiException ? c.json({ message: error.message }, error.status) : c.json({}, 500));
    app.use('/api/*', async (c, next) => { c.set('actor', actor); await next(); });
    const b = registerBackups(app, new Pages(s, new Events())); services.push(b);
    const original = actor;
    for (const forbidden of [{ ...original, access: 'read' }, { ...original, workspaceId: 'w' }, { ...original, user: { isAdmin: false } }]) {
      actor = forbidden;
      for (const [method, path] of [['GET', '/api/admin/backups/settings'], ['GET', '/api/admin/backups'], ['POST', '/api/admin/backups/run'], ['GET', '/api/admin/backups/x/download']]) expect((await app.request(path, { method })).status).toBe(403);
    }
    actor = original;
    const settings = b.settings();
    expect((await app.request('/api/admin/backups/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, destinations: [local] }) })).status).toBe(200);
    const response = await app.request('/api/admin/backups/run', { method: 'POST' }); expect(response.status).toBe(200);
    const run = await response.json(); await b.waitForIdle();
    const download = await app.request(`/api/admin/backups/${run.id}/download`); expect(download.status).toBe(200);
    expect(download.headers.get('Content-Type')).toBe('application/zip');
    expect(unzipSync(new Uint8Array(await download.arrayBuffer()))['cairn.db']).toBeDefined();
  });
  it('uses array arguments and a private config for rclone and removes its temporary configuration', async () => {
    const { dir, s } = setup(); const binaryDir = join(dir, 'bin'); mkdirSync(binaryDir);
    const log = join(dir, 'rclone-log.jsonl'); const binary = join(binaryDir, 'rclone');
    writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === 'version') process.exit(0);
const config = args[args.indexOf('--config') + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, mode: fs.statSync(config).mode & 511, secret: fs.readFileSync(config, 'utf8') }) + String.fromCharCode(10));
if (args[0] === 'lsf') fs.writeSync(1, ['cairn-backup-20000101-000000.zip', 'unrelated.zip', ''].join(String.fromCharCode(10)));
`); chmodSync(binary, 0o700);
    const oldPath = process.env.PATH; process.env.PATH = `${binaryDir}:${oldPath}`;
    try {
      const b = service(s); expect(b.settings().rcloneAvailable).toBe(true);
      b.saveSettings({ ...b.settings(), keep: 1, destinations: [{ id: 'r', name: 'Remote', type: 'rclone', hasSecret: false, config: { remote: 'remote:folder with spaces;echo dangerous', config: '[remote]\nsecret = abc' } }] });
      b.start(); await b.waitForIdle(); expect(b.list()[0].status).toBe('done');
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.every(call => call.mode === 0o600 && call.secret.includes('secret = abc'))).toBe(true);
      expect(calls[0].args[2]).toContain('folder with spaces;echo dangerous/');
      expect(calls.some(call => call.args[0] === 'deletefile' && call.args[1].endsWith('20000101-000000.zip'))).toBe(true);
      expect(calls.some(call => call.args.includes('unrelated.zip'))).toBe(false);
      expect(readdirSync(dir).some(name => name.startsWith('.rclone-'))).toBe(false);
    } finally { process.env.PATH = oldPath; }
  });
  it.each([1, 0xffffffff])('rejects excessive or inconsistent ZIP expansion (%i) before restoring a backup', async declaredSize => {
    const { dir, s } = setup();
    s.put('users', { id: 'preserve', name: 'Preserve' });
    const bytes = zipSync({ 'cairn.db': strToU8('not a database'), 'manifest.json': strToU8('{}') });
    // Reject both a huge advertised size and output exceeding a smaller declaration.
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(22, declaredSize, true);
    const file = join(dir, 'bomb.zip'); writeFileSync(file, bytes);
    await expect(restoreBackup(file, dir)).rejects.toThrow(/expanded archive/i);
    expect(s.get('users', 'preserve')?.name).toBe('Preserve');
    expect(readdirSync(dir).some(name => name.startsWith('.restore-'))).toBe(false);
  });
  it('rejects directory entries carrying data instead of bypassing expansion accounting', async () => {
    const { dir } = setup();
    const file = join(dir, 'directory-data.zip');
    writeFileSync(file, zipSync({ 'files/folder/': strToU8('payload'), 'cairn.db': strToU8('db'), 'manifest.json': strToU8('{}') }));
    await expect(restoreBackup(file, dir)).rejects.toThrow(/directory entries must be empty/i);
    expect(readdirSync(dir).some(name => name.startsWith('.restore-'))).toBe(false);
  });
  it('rejects malformed archives and traversal paths without changing current data', async () => {
    const { dir, s } = setup(); s.put('users', { id: 'safe' }); s.close();
    const file = join(dir, 'bad.zip'); writeFileSync(file, zipSync({ '../escape': strToU8('bad'), 'cairn.db': strToU8('not sqlite'), 'manifest.json': strToU8('{}') }));
    await expect(restoreBackup(file, dir)).rejects.toThrow();
    const check = new Store(dir); stores.push(check); expect(check.get('users', 'safe')).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { parseICS } from '../src/ics.ts';
import type { Actor } from '../src/common.ts';

let dir: string, store: Store, pages: Pages, actor: Actor;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-backend-review-'));
  store = new Store(dir);
  pages = new Pages(store, new Events());
  actor = { user: { id: 'owner', name: 'Owner', email: 'owner@example.com', color: '#000000', isAdmin: true, disabled: false, createdAt: now(), lastSeenAt: null, prefs: { theme: 'system', accent: 'blue' } }, actorType: 'user', clientId: null };
  store.put('users', actor.user);
  store.put('workspaces', { id: 'workspace', name: 'Workspace' });
  store.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('workspace', actor.user.id, 'owner', now());
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('database schema integrity', () => {
  it('removes deleted properties and option ids from active, private and trashed rows', () => {
    const database = pages.create(actor, 'workspace', { kind: 'database', schema: [
      { id: 'text', name: 'Text', type: 'text' },
      { id: 'select', name: 'State', type: 'select', options: [{ id: 'old', name: 'Obsolete', color: 'gray' }] },
      { id: 'multi', name: 'Tags', type: 'multi_select', options: [{ id: 'old', name: 'Obsolete', color: 'gray' }, { id: 'keep', name: 'Retained', color: 'blue' }] },
    ] });
    const rows = ['active', 'private', 'trash'].map(title => pages.create(actor, 'workspace', { kind: 'row', title, parentId: database.id, visibility: title === 'private' ? 'private' : 'workspace', props: { text: 'Remove me', select: 'old', multi: ['old', 'keep'] } }));
    pages.remove(actor, rows[2].id);
    pages.patch(actor, database.id, { schema: [
      { id: 'select', name: 'State', type: 'select', options: [] },
      { id: 'multi', name: 'Tags', type: 'multi_select', options: [{ id: 'keep', name: 'Retained', color: 'blue' }] },
    ] });
    for (const row of rows) expect(store.get('pages', row.id).props).toEqual({ multi: ['keep'] });
    expect(pages.search(actor, 'workspace', 'Obsolete')).toEqual([]);
    expect(pages.search(actor, 'workspace', 'Retained')).toHaveLength(2);
  });
});

it('keeps repeated insertions strictly ordered when float midpoints lose precision', () => {
  const first = pages.create(actor, 'workspace', { title: 'First' });
  pages.create(actor, 'workspace', { title: 'Last' });
  const expected = [first.id];
  for (let i = 0; i < 100; i++) {
    const inserted = pages.create(actor, 'workspace', { title: String(i), afterId: first.id });
    expected.splice(1, 0, inserted.id);
  }
  const ordered = pages.list(actor, 'workspace').sort((a, b) => a.position - b.position);
  expect(ordered.slice(0, -1).map(page => page.id)).toEqual(expected);
  expect(new Set(ordered.map(page => page.position)).size).toBe(102);
});

const calendar = (event: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${event}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
it('respects independently specified DTEND timezones and overlap with the requested window', () => {
  const source = calendar('DTSTART;TZID=America/Toronto:20261101T090000\r\nDTEND:20261101T150000Z\r\nRRULE:FREQ=DAILY;COUNT=2');
  expect(parseICS(source, '2026-11-01', '2026-11-03').map(event => [event.start, event.end])).toEqual([
    ['2026-11-01T14:00:00.000Z', '2026-11-01T15:00:00.000Z'],
    ['2026-11-02T14:00:00.000Z', '2026-11-02T15:00:00.000Z'],
  ]);
  expect(parseICS(source, '2026-11-01T15:00:00Z', '2026-11-02')).toEqual([]);
});

it('serves SVG uploads as attachments regardless of MIME casing', async () => {
  const { Hono } = await import('hono');
  const { registerAssets } = await import('../src/assets.ts');
  const { createSession } = await import('../src/auth.ts');
  const { storeFile } = await import('../src/file-storage.ts');
  const { ApiException } = await import('../src/common.ts');
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, error instanceof ApiException ? error.status : 500));
  app.get('/session', c => c.text(createSession(store, c, actor.user.id)));
  registerAssets(app, pages);
  const login = await app.request('/session');
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const file = await storeFile(store, actor, 'workspace', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image.svg', 'image/SVG+XML');
  const response = await app.request(file.url, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

describe('server lock', () => {
  it('treats a lock left by an earlier process with our PID as stale (container restarts reuse PID 1)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { acquireServerLock, serverIsRunning } = await import('../src/backups.ts');
    const dir = mkdtempSync(join(tmpdir(), 'cairn-lock-'));
    try {
      writeFileSync(join(dir, 'cairn.server.lock'), String(process.pid));
      expect(serverIsRunning(dir)).toBe(false);
      const release = acquireServerLock(dir);
      expect(serverIsRunning(dir)).toBe(true);
      release();
      expect(serverIsRunning(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { Notifications } from '../src/notifications.ts';
import { changeDetail, undoChange } from '../src/changes.ts';
import { Calendars } from '../src/calendars.ts';
import { exportPage, exportWorkspace, importFile, storeImportFile } from '../src/transfer.ts';
import { purgeExpired } from '../src/housekeeping.ts';
import type { Actor } from '../src/common.ts';
import type { Page, Property, Repeat } from '../../shared/types.ts';
let dir: string, s: Store, pages: Pages, actor: Actor;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-v03-data-'));
  s = new Store(dir);
  pages = new Pages(s, new Events());
  s.put('users', {
    id: 'u',
    name: 'Owner',
    email: 'o@example.com',
    color: '',
    isAdmin: true,
    disabled: false,
    createdAt: '',
    lastSeenAt: null,
  });
  s.put('workspaces', { id: 'w' });
  s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('w', 'u', 'owner', '');
  actor = { user: s.get('users', 'u'), actorType: 'user', clientId: null };
});
afterEach(() => {
  pages.notifications?.close();
  s.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});
const database = (schema: Property[]) => pages.create(actor, 'w', { kind: 'database', title: 'Database', schema });
const row = (db: Page, props: Page['props'] = {}, title = 'Row') =>
  pages.create(actor, 'w', { kind: 'row', parentId: db.id, title, props });
it('validates real workspace files, exports filenames and imports no files values', async () => {
  const db = database([{ id: 'f', name: 'Attachments', type: 'files' }]);
  const url = await storeImportFile(pages, actor, 'w', 'notes one.txt', new Uint8Array([65]), 'text/plain');
  const p = row(db, { f: [url] });
  expect(exportPage(pages, actor, db.id, 'csv')).toContain('notes one.txt');
  s.put('files', { id: 'foreign', workspaceId: 'other', name: 'file.txt' });
  expect(() => pages.patch(actor, p.id, { props: { f: ['/files/foreign/file.txt'] } })).toThrow('existing upload');
  expect(() => pages.patch(actor, p.id, { props: { f: [url.replace('notes%20one.txt', 'renamed.txt')] } })).toThrow();
  const [copyId] = await importFile(
    pages,
    actor,
    'w',
    null,
    'data.json',
    new TextEncoder().encode(exportPage(pages, actor, db.id, 'json')),
  );
  expect(pages.rows(actor, copyId)[0].props).toEqual({});
});
it('computes incoming rollups with actor visibility and validates source/function types', () => {
  const projects = database([{ id: 'n', name: 'Number', type: 'number' }]);
  const tasks = database([
    { id: 'project', name: 'Project', type: 'relation', relationDatabaseId: projects.id },
    { id: 'hours', name: 'Hours', type: 'number' },
  ]);
  const project = row(projects, {}, 'Project');
  row(tasks, { project: [project.id], hours: 3 });
  const hidden = row(tasks, { project: [project.id], hours: 100 });
  pages.patch(actor, hidden.id, { visibility: 'private' });
  pages.patch(actor, projects.id, {
    schema: [
      ...projects.schema,
      {
        id: 'total',
        name: 'Total',
        type: 'rollup',
        rollup: {
          source: { kind: 'incoming', databaseId: tasks.id, propertyId: 'project' },
          target: 'hours',
          fn: 'sum',
        },
      },
    ],
  });
  expect(pages.computed(actor, pages.get(actor, project.id)).props.total).toBe(103);
  s.put('users', { ...actor.user, id: 'other', email: 'other@example.com' });
  s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('w', 'other', 'member', '');
  const other = { ...actor, user: s.get('users', 'other') };
  expect(pages.computed(other, pages.get(other, project.id)).props.total).toBe(3);
  expect(() =>
    pages.patch(actor, projects.id, {
      schema: [
        {
          id: 'bad',
          name: 'Bad',
          type: 'rollup',
          rollup: {
            source: { kind: 'incoming', databaseId: tasks.id, propertyId: 'hours' },
            target: 'hours',
            fn: 'sum',
          },
        },
      ],
    }),
  ).toThrow('Incoming source');
  expect(() =>
    pages.patch(actor, projects.id, {
      schema: [
        {
          id: 'bad',
          name: 'Bad',
          type: 'rollup',
          rollup: {
            source: { kind: 'incoming', databaseId: tasks.id, propertyId: 'project' },
            target: 'hours',
            fn: 'earliest',
          },
        },
      ],
    }),
  ).toThrow('fit');
});
it.each([
  ['day', '2026-11-13'],
  ['week', '2026-11-19'],
  ['month', '2026-12-12'],
  ['year', '2027-11-12'],
] as const)('repeats a completed row by %s in the same write and records the reset', (unit, next) => {
  const db = database([
    { id: 'date', name: 'Due', type: 'date' },
    { id: 'done', name: 'Done', type: 'checkbox' },
  ]);
  pages.notifications = new Notifications(s, pages, pages.events, { clock: () => new Date('2026-11-12T12:00:00Z') });
  const p = row(db, { date: '2026-11-12', done: false });
  const repeat: Repeat = {
    dateProp: 'date',
    doneProp: 'done',
    doneValue: true,
    resetValue: false,
    every: 1,
    unit,
    from: 'due',
    until: null,
  };
  pages.patch(actor, p.id, {
    repeat,
    reminders: [{ dateProp: 'date', offsetMinutes: 0, at: null, userIds: [], personProp: null }],
  });
  const current = pages.get(actor, p.id);
  current.reminders[0].lastFiredFor = '2026-11-12';
  s.put('pages', current);
  const result = pages.patch(actor, p.id, { props: { done: true } });
  expect(result.props).toMatchObject({ date: next, done: false });
  expect(result.reminders[0].lastFiredFor).toBeNull();
  expect(pages.activity(actor, 'w')[0].action).toBe('repeated');
});
it('uses actor-local completed date, stops at until and rejects invalid repeats/reminders', () => {
  pages.notifications = new Notifications(s, pages, pages.events, { clock: () => new Date('2026-11-13T01:00:00Z') });
  actor.user.prefs.timezone = 'America/Los_Angeles';
  const db = database([
    { id: 'd', name: 'Due', type: 'date' },
    {
      id: 's',
      name: 'State',
      type: 'status',
      options: [
        { id: 'done', name: 'Done', color: 'green' },
        { id: 'open', name: 'Open', color: 'gray' },
      ],
    },
  ]);
  const p = row(db, { d: '2026-01-01T15:00:00Z', s: 'open' });
  const repeat: Repeat = {
    dateProp: 'd',
    doneProp: 's',
    doneValue: 'done',
    resetValue: 'open',
    every: 1,
    unit: 'day',
    from: 'completed',
    until: '2026-11-13',
  };
  pages.patch(actor, p.id, { repeat });
  expect(pages.patch(actor, p.id, { props: { s: 'done' } }).props.d).toBe('2026-11-13T15:00:00Z');
  pages.patch(actor, p.id, { repeat: { ...repeat, until: '2026-11-12' } });
  const last = pages.patch(actor, p.id, { props: { s: 'done' } });
  expect(last.repeat).toBeNull();
  expect(last.props.s).toBe('done');
  expect(pages.activity(actor, 'w')[0].action).toBe('repeated');
  expect(() => pages.patch(actor, p.id, { repeat: { ...repeat, doneValue: 'nonexistent' } })).toThrow();
  expect(() => pages.patch(actor, p.id, { repeat: { ...repeat, weekdays: [1] } })).toThrow();
  const page = pages.create(actor, 'w', {});
  expect(() =>
    pages.patch(actor, page.id, {
      reminders: [{ dateProp: 'd', offsetMinutes: 0, at: null, userIds: [], personProp: null }],
    }),
  ).toThrow();
});
it('merges only within the edit window and client, and force undo restores exactly touched fields', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
  const p = pages.create(actor, 'w', { title: 'Original', icon: 'a' });
  pages.patch(actor, p.id, { title: 'First' });
  vi.advanceTimersByTime(60000);
  pages.patch(actor, p.id, { title: 'Second' });
  let updates = pages.changes(actor, 'w', { actor: 'all' }).filter((c) => c.action === 'updated');
  expect(updates).toHaveLength(1);
  expect(changeDetail(pages, actor, updates[0].id).diffs).toEqual([
    { field: 'Title', before: 'Original', after: 'Second' },
  ]);
  vi.advanceTimersByTime(120001);
  pages.patch(actor, p.id, { icon: 'b' });
  updates = pages.changes(actor, 'w', { actor: 'all' }).filter((c) => c.action === 'updated');
  expect(updates).toHaveLength(2);
  expect(() => undoChange(pages, actor, updates[1].id)).toThrow('changed since');
  undoChange(pages, actor, updates[1].id, true);
  expect(pages.get(actor, p.id)).toMatchObject({ title: 'Original', icon: 'b' });
  const ai = { ...actor, actorType: 'ai' as const, clientName: 'Agent A' };
  pages.patch(ai, p.id, { title: 'Agent edit' });
  expect(pages.changes(actor, 'w')[0].clientName).toBe('Agent A');
  expect(pages.activity(actor, 'w')[0].clientName).toBe('Agent A');
});
it('undoes create, delete, restore, move, content, properties and schema independently', () => {
  const p = pages.create(actor, 'w', { title: 'Page' }),
    parent = pages.create(actor, 'w', { title: 'Parent' });
  pages.move(actor, p.id, parent.id);
  let c = pages.changes(actor, 'w', { actor: 'all' }).find((c) => c.pageId === p.id && c.action === 'moved')!;
  undoChange(pages, actor, c.id);
  expect(pages.get(actor, p.id).parentId).toBeNull();
  pages.remove(actor, p.id);
  c = pages.changes(actor, 'w', { actor: 'all' }).find((c) => c.pageId === p.id && c.action === 'deleted')!;
  undoChange(pages, actor, c.id);
  expect(pages.get(actor, p.id).deletedAt).toBeNull();
  pages.remove(actor, p.id);
  pages.restore(actor, p.id);
  c = pages.changes(actor, 'w', { actor: 'all' }).find((c) => c.pageId === p.id && c.action === 'restored')!;
  undoChange(pages, actor, c.id);
  expect(pages.get(actor, p.id, false, true).deletedAt).not.toBeNull();
  const db = database([{ id: 'x', name: 'Count', type: 'number' }]),
    r = row(db, { x: 1 });
  pages.patch(actor, r.id, {
    props: { x: 2 },
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] },
  });
  c = pages.changes(actor, 'w', { actor: 'all' }).find((c) => c.pageId === r.id && c.action === 'updated')!;
  undoChange(pages, actor, c.id);
  expect(pages.get(actor, r.id)).toMatchObject({ props: { x: 1 }, content: null });
  pages.patch(actor, db.id, { schema: [...db.schema, { id: 'y', name: 'Text', type: 'text' }] });
  c = pages.changes(actor, 'w', { actor: 'all' }).find((c) => c.pageId === db.id && c.action === 'updated')!;
  undoChange(pages, actor, c.id);
  expect(pages.get(actor, db.id).schema).toEqual(db.schema);
  const created = pages
    .changes(actor, 'w', { actor: 'all' })
    .find((c) => c.pageId === parent.id && c.action === 'created')!;
  undoChange(pages, actor, created.id);
  expect(pages.get(actor, parent.id, false, true).deletedAt).not.toBeNull();
});
it('exports comments, retains templates in JSON but omits them from CSV and calendars, and prunes 90-day records', async () => {
  const db = database([{ id: 'd', name: 'Date', type: 'date' }]);
  const r = row(db, { d: '2026-11-12' }, 'Visible');
  const template = pages.saveAsTemplate(actor, r.id, 'Hidden template');
  pages.patch(actor, db.id, { defaultTemplateId: template.id });
  const c = pages.addComment(actor, r.id, { body: 'Preserve this comment' });
  const data = JSON.parse(exportPage(pages, actor, db.id, 'json'));
  expect(data.comments[0].id).toBe(c.id);
  expect(data.pages.some((p: Page) => p.id === template.id)).toBe(true);
  expect(exportPage(pages, actor, db.id, 'csv')).not.toContain('Hidden template');
  expect(new Calendars(pages).rowEvents(actor, 'w').map((e) => e.pageId)).toEqual([r.id]);
  const zip = unzipSync(await exportWorkspace(pages, actor, 'w'));
  expect(JSON.parse(strFromU8(zip['cairn.json'])).comments[0].body).toBe(c.body);
  const [copy] = await importFile(pages, actor, 'w', null, 'copy.json', new TextEncoder().encode(JSON.stringify(data)));
  const copied = pages.get(actor, copy);
  expect(copied.defaultTemplateId).toBeTruthy();
  expect(pages.get(actor, copied.defaultTemplateId!).isTemplate).toBe(true);
  expect(pages.comments(actor, pages.rows(actor, copy)[0].id)[0].body).toBe(c.body);
  s.put('notifications', { id: 'expired', at: '2000-01-01', userId: 'u' });
  s.put('changes', { id: 'expired', at: '2000-01-01' });
  purgeExpired(s, pages);
  expect(s.get('notifications', 'expired')).toBeUndefined();
  expect(s.get('changes', 'expired')).toBeUndefined();
});

it('enforces reminder counts and repeat intervals through all callers', () => {
  const db = database([
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'done', name: 'Done', type: 'checkbox' },
  ]);
  const p = row(db);
  expect(() =>
    pages.patch(actor, p.id, {
      repeat: {
        dateProp: 'date',
        doneProp: 'done',
        doneValue: true,
        resetValue: false,
        every: 0,
        unit: 'day',
        from: 'due',
        until: null,
      },
    }),
  ).toThrow();
  expect(() =>
    pages.patch(actor, p.id, {
      reminders: Array.from({ length: 11 }, () => ({
        dateProp: null,
        offsetMinutes: 0,
        at: '2026-12-12T09:00:00Z',
        userIds: [],
        personProp: null,
      })),
    }),
  ).toThrow();
});

it('undoes destructive schema cleanup along with the database and records row changes', () => {
  const db = database([
    { id: 'x', name: 'Value', type: 'number' },
    {
      id: 's',
      name: 'State',
      type: 'select',
      options: [
        { id: 'a', name: 'A', color: 'gray' },
        { id: 'b', name: 'B', color: 'blue' },
      ],
    },
  ]);
  const p = row(db, { x: 5, s: 'b' });
  pages.patch(actor, db.id, { schema: [{ ...db.schema[1], options: [db.schema[1].options![0]] }] });
  expect(pages.get(actor, p.id).props).toEqual({});
  const changes = pages.changes(actor, 'w', { actor: 'all' });
  expect(changes.some((c) => c.pageId === p.id && c.action === 'updated')).toBe(true);
  const rowChange = changes.find((c) => c.pageId === p.id && c.action === 'updated')!;
  expect(rowChange.fields).toEqual(['Value', 'State']);
  expect(changeDetail(pages, actor, rowChange.id).diffs).toContainEqual({ field: 'State', before: 'B', after: '' });
  const c = changes.find((c) => c.pageId === db.id && c.action === 'updated')!;
  undoChange(pages, actor, c.id);
  expect(pages.get(actor, p.id).props).toEqual({ x: 5, s: 'b' });
});
it('keeps default templates valid when templates are moved or unflagged and page templates stay roots', () => {
  const db = database([{ id: 'x', name: 'X', type: 'number' }]),
    other = database([]);
  const p = row(db);
  const t = pages.saveAsTemplate(actor, p.id);
  pages.patch(actor, db.id, { defaultTemplateId: t.id });
  pages.patch(actor, t.id, { isTemplate: false });
  expect(pages.get(actor, db.id).defaultTemplateId).toBeNull();
  pages.patch(actor, t.id, { isTemplate: true });
  pages.patch(actor, db.id, { defaultTemplateId: t.id });
  pages.move(actor, t.id, other.id);
  expect(pages.get(actor, db.id).defaultTemplateId).toBeNull();
  const page = pages.create(actor, 'w', { title: 'Root' });
  const template = pages.saveAsTemplate(actor, page.id);
  expect(() => pages.move(actor, template.id, page.id)).toThrow();
});

it('round trips rollups targeting later databases with computed rollup targets', async () => {
  const a = database([{ id: 'bs', name: 'B rows', type: 'relation' }]);
  const c = database([{ id: 'n', name: 'Value', type: 'number' }]);
  const b = database([
    { id: 'cs', name: 'C rows', type: 'relation', relationDatabaseId: c.id },
    {
      id: 'sub',
      name: 'Subtotal',
      type: 'rollup',
      rollup: { source: { kind: 'relation', propertyId: 'cs' }, target: 'n', fn: 'sum' },
    },
  ]);
  pages.patch(actor, a.id, {
    schema: [
      { ...a.schema[0], relationDatabaseId: b.id },
      {
        id: 'total',
        name: 'Total',
        type: 'rollup',
        rollup: { source: { kind: 'relation', propertyId: 'bs' }, target: 'sub', fn: 'sum' },
      },
    ],
  });
  const cr = row(c, { n: 4 }),
    br = row(b, { cs: [cr.id] });
  row(a, { bs: [br.id] });
  const archive = await exportWorkspace(pages, actor, 'w');
  const ids = await importFile(pages, actor, 'w', null, 'computed.zip', archive);
  const copied = pages.get(actor, ids[0]);
  expect(pages.rows(actor, copied.id)[0].props[copied.schema[1].id]).toBe(4);
});
it('detects newer edits to rows before undoing schema cleanup and rolls back atomically', () => {
  const db = database([{ id: 'x', name: 'X', type: 'number' }]),
    p = row(db, { x: 9 });
  pages.patch(actor, db.id, { schema: [] });
  const c = pages.changes(actor, 'w', { actor: 'all' }).find((c) => c.pageId === db.id && c.action === 'updated')!;
  pages.patch(actor, p.id, { title: 'Newer' });
  expect(() => undoChange(pages, actor, c.id)).toThrow('changed since');
  expect(pages.get(actor, db.id).schema).toEqual([]);
  expect(pages.get(actor, p.id).props).toEqual({});
  undoChange(pages, actor, c.id, true);
  expect(pages.get(actor, p.id)).toMatchObject({ title: 'Newer', props: { x: 9 } });
});
it('undoes merged schema removals on the same row and rebuilds restored relation backlinks', () => {
  const db = database([
    { id: 'x', name: 'X', type: 'number' },
    { id: 'rel', name: 'Related', type: 'relation' },
  ]);
  const target = pages.create(actor, 'w', { title: 'Target' });
  const p = row(db, { x: 3, rel: [target.id] });
  pages.patch(actor, db.id, { schema: [db.schema[1]] });
  pages.patch(actor, db.id, { schema: [] });
  const c = pages.changes(actor, 'w', { actor: 'all' }).find((c) => c.pageId === db.id && c.action === 'updated')!;
  undoChange(pages, actor, c.id);
  expect(pages.get(actor, p.id).props).toEqual({ x: 3, rel: [target.id] });
  expect(pages.backlinks(actor, target.id)[0].id).toBe(p.id);
});
it('preserves a default template when a move is rejected', () => {
  const db = database([]),
    other = database([]),
    p = row(db),
    t = pages.saveAsTemplate(actor, p.id);
  pages.patch(actor, db.id, { defaultTemplateId: t.id });
  expect(() => pages.move(actor, t.id, other.id, p.id)).toThrow();
  expect(pages.get(actor, db.id).defaultTemplateId).toBe(t.id);
});
it('migrates a v0.2 database without any v0.3 tables and rebuilds stored links', () => {
  const legacyDir = mkdtempSync(join(tmpdir(), 'cairn-legacy-v02-'));
  const legacy = new Store(legacyDir);
  legacy.put('users', { id: 'legacy', email: 'legacy@example.com', prefs: { theme: 'dark', accent: 'green' } });
  legacy.put('pages', {
    id: 'source',
    workspaceId: 'w',
    parentId: null,
    kind: 'page',
    title: 'Source',
    props: {},
    schema: [],
    views: [],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: 'target', title: 'Target' } }] }],
    },
  });
  legacy.put('activity', { id: 'old', action: 'updated' });
  legacy.db.exec(
    'DROP TABLE links; DROP TABLE notifications; DROP TABLE pushSubscriptions; DROP TABLE mailSettings; DROP TABLE comments; DROP TABLE changes; PRAGMA user_version=2',
  );
  legacy.close();
  const migrated = new Store(legacyDir);
  try {
    expect(migrated.db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    expect(migrated.db.prepare('SELECT * FROM links').all()).toEqual([
      { fromId: 'source', toId: 'target', via: 'mention' },
    ]);
    expect(migrated.get('users', 'legacy').prefs).toMatchObject({
      theme: 'dark',
      accent: 'green',
      timezone: 'UTC',
      reminderHour: 9,
      capture: null,
    });
    expect(migrated.get('activity', 'old').clientName).toBeNull();
    expect(migrated.all('notifications')).toEqual([]);
    expect(migrated.get('pages', 'source')).toMatchObject({
      repeat: null,
      reminders: [],
      isTemplate: false,
      defaultTemplateId: null,
    });
  } finally {
    migrated.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

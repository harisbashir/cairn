import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { Store } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { exportPage, exportWorkspace, importFile, inferColumn, parseCsv, storeImportFile } from '../src/transfer.ts';
import { Jobs } from '../src/jobs.ts';
import { Notion } from '../src/notion.ts';
import type { Actor } from '../src/common.ts';
let dir: string, pages: Pages, actor: Actor;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-transfer-'));
  const s = new Store(dir); pages = new Pages(s, new Events());
  actor = { user: { id: 'owner', name: 'Owner', email: 'owner@test.test', color: '', disabled: false, isAdmin: false, createdAt: '', lastSeenAt: null, prefs: { theme: 'system', accent: 'blue' } }, actorType: 'user', clientId: null };
  s.put('users', actor.user); s.put('workspaces', { id: 'wid' });
  s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('wid', actor.user.id, 'owner', '');
});
afterEach(() => { pages.s.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
describe('portable workspace exports', () => {
  it('round-trips schema, views, references, hierarchy, files and dashboard state', async () => {
    const db = pages.create(actor, 'wid', { title: 'Tasks', kind: 'database', schema: [{ id: 'state', name: 'State', type: 'select', options: [{ id: 'done', name: 'Done', color: 'green' }] }, { id: 'rel', name: 'Related', type: 'relation' }], views: [{ id: 'board', name: 'Board', type: 'board', filters: [{ propertyId: 'state', op: 'eq', value: 'done' }], sorts: [], groupBy: 'state' }] });
    const url = await storeImportFile(pages, actor, 'wid', 'test.png', new Uint8Array([1, 2, 3]), 'image/png');
    const row = pages.create(actor, 'wid', { title: 'First', kind: 'row', parentId: db.id, props: { state: 'done' }, content: { type: 'doc', content: [{ type: 'image', attrs: { src: url } }] } });
    pages.patch(actor, db.id, { schema: db.schema.map(p => p.id === 'rel' ? { ...p, relationDatabaseId: db.id } : p) });
    pages.patch(actor, row.id, { props: { rel: [row.id] } });
    pages.s.put('stickies', { id: 'note', workspaceId: 'wid', text: 'Hi', visibility: 'workspace', createdBy: actor.user.id });
    pages.s.put('layouts', { id: 'wid', workspaceId: 'wid', widgets: [{ id: 'widget', type: 'view', size: 'half', config: { databaseId: db.id, viewId: 'board' } }] });
    const archive = await exportWorkspace(pages, actor, 'wid');
    const files = unzipSync(archive); expect(files['Tasks.csv']).toBeDefined(); expect(strFromU8(files['Tasks/First.md'])).toContain('../files/');
    const roots = await importFile(pages, actor, 'wid', null, 'export.zip', archive);
    expect(roots).toHaveLength(1); expect(roots[0]).not.toBe(db.id);
    const copy = pages.get(actor, roots[0]), copiedRows = pages.rows(actor, copy.id);
    expect(copiedRows).toHaveLength(1); const imported = pages.get(actor, copiedRows[0].id);
    expect(imported.props[copy.schema[0].id]).toBe(copy.schema[0].options![0].id);
    expect(imported.props[copy.schema[1].id]).toEqual([imported.id]);
    expect(copy.schema[1].relationDatabaseId).toBe(copy.id);
    expect(copy.views[0].groupBy).toBe(copy.schema[0].id);
    expect(imported.content?.content?.[0].attrs?.src).not.toBe(url);
    expect(pages.s.get('layouts', 'wid').widgets[0].config.databaseId).toBe(copy.id);
    expect(pages.s.all('files')).toHaveLength(2);
  });
  it('infers types and handles RFC CSV quoting', async () => {
    expect(parseCsv('Name,Text\r\n"A, B","a""b\nc"')).toEqual([['Name', 'Text'], ['A, B', 'a"b\nc']]);
    expect(inferColumn('Count', ['0', '1.5']).type).toBe('number');
    expect(inferColumn('Done', ['TRUE', 'false']).type).toBe('checkbox');
    expect(inferColumn('Date', ['2026-11-11']).type).toBe('date');
    expect(inferColumn('URL', ['https://example.com']).type).toBe('url');
    expect(inferColumn('Tags', ['a;b', 'b;c']).type).toBe('multi_select');
    const [dbId] = await importFile(pages, actor, 'wid', null, 'tasks.csv', strToU8('Name,Count,Done,Tags\nA,2,true,a;b\nB,3,false,b;c'));
    const db = pages.get(actor, dbId); expect(db.schema.map(p => p.type)).toEqual(['number', 'checkbox', 'multi_select']);
    expect(exportPage(pages, actor, dbId, 'csv')).toContain('A,2,true,a;b');
  });
  it('rebuilds a Notion Markdown and CSV archive and imports relative images', async () => {
    const suffix = ' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const archive = zipSync({ ['Parent' + suffix + '.md']: strToU8('# Parent'), ['Parent' + suffix + '/Tasks' + suffix + '.csv']: strToU8('Name,Score\nExample,3'), ['Parent' + suffix + '/Tasks' + suffix + '/Example' + suffix + '.md']: strToU8('# Example\n\n![alt](pic.png)'), ['Parent' + suffix + '/Tasks' + suffix + '/pic.png']: new Uint8Array([1]) });
    const [root] = await importFile(pages, actor, 'wid', null, 'notion.zip', archive);
    expect(pages.get(actor, root).title).toBe('Parent');
    const db = pages.list(actor, 'wid').find(p => p.kind === 'database')!;
    expect(db.parentId).toBe(root); const rows = pages.rows(actor, db.id); expect(rows).toHaveLength(1);
    const row = pages.get(actor, rows[0].id); expect(row.content?.content?.find(p => p.type === 'image')?.attrs?.src).toMatch(/^\/files\//);
  });
  it('hides inaccessible relation titles in readable exports and other users personal layouts', async () => {
    const secret = pages.create(actor, 'wid', { title: 'Secret', visibility: 'private' });
    const db = pages.create(actor, 'wid', { title: 'DB', kind: 'database', schema: [{ id: 'relation', name: 'Related', type: 'relation' }] });
    pages.create(actor, 'wid', { title: 'Row', kind: 'row', parentId: db.id, props: { relation: [secret.id] } });
    const other = { ...actor, user: { ...actor.user, id: 'other', email: 'other@test.test' } }; pages.s.put('users', other.user); pages.s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('wid', 'other', 'member', '');
    expect(exportPage(pages, other, db.id, 'csv')).not.toContain('Secret');
    pages.s.put('layouts', { id: 'wid:owner', workspaceId: 'wid', widgets: [{ title: 'private dashboard' }] });
    expect(strFromU8(unzipSync(await exportWorkspace(pages, other, 'wid'))['cairn.json'])).not.toContain('private dashboard');
  });
});
it('jobs are creator-only, asynchronous, expire and never expose task errors', async () => {
  let time = 0; const jobs = new Jobs(() => time);
  const job = jobs.start('owner', 'import', async update => { update('Importing'); return { pageIds: ['a'] }; });
  expect(job.status).toBe('running'); expect(() => jobs.get(job.id, 'other')).toThrow('Job not found.');
  await new Promise(resolve => setTimeout(resolve, 0)); expect(jobs.get(job.id, 'owner').result?.pageIds).toEqual(['a']);
  time = 3600001; expect(() => jobs.get(job.id, 'owner')).toThrow('Job not found.');
  const bad = jobs.start('owner', 'notion-import', async () => { throw new Error('secret-token'); });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(JSON.stringify(jobs.get(bad.id, 'owner'))).not.toContain('secret-token');
});
it('imports paginated Notion databases with two-pass relation ids and retries 429', async () => {
  vi.useFakeTimers(); let searches = 0, throttles = 0;
  const mock = vi.fn(async (input: any, init: any) => {
    const path = new URL(String(input)).pathname, data = init.body ? JSON.parse(init.body) : {};
    if (path === '/v1/search') {
      searches++; return Response.json(searches === 1 ? { results: [{ id: 'db1', object: 'data_source', title: [{ plain_text: 'First' }] }], has_more: true, next_cursor: 'next' } : { results: [{ id: 'db2', object: 'data_source', title: [{ plain_text: 'Second' }] }] });
    }
    if (path === '/v1/data_sources/db1' && !throttles++) return new Response('', { status: 429, headers: { 'retry-after': '0.001' } });
    if (/\/data_sources\/db[12]$/.test(path)) return Response.json({ id: path.endsWith('1') ? 'db1' : 'db2', title: [{ plain_text: path.endsWith('1') ? 'First' : 'Second' }], properties: { Name: { type: 'title' }, Related: { type: 'relation', relation: { data_source_id: 'db2' } } } });
    if (path.endsWith('/query')) { const first = path.includes('db1'); return Response.json({ results: [{ id: first ? 'row1' : 'row2', properties: { Name: { type: 'title', title: [{ plain_text: first ? 'One' : 'Two' }] }, Related: { type: 'relation', relation: first ? [{ id: 'row2' }] : [] } } }] }); }
    if (path.endsWith('/children')) return Response.json({ results: [] });
    throw new Error('Unexpected ' + path + JSON.stringify(data));
  });
  const promise = new Notion(pages, actor, 'wid', 'secret', mock as typeof fetch).import(['db1', 'db2'], null, () => {});
  await vi.runAllTimersAsync(); const roots = await promise; expect(roots).toHaveLength(2);
  const first = pages.get(actor, roots[0]), second = pages.get(actor, roots[1]);
  expect(first.schema[0].relationDatabaseId).toBe(second.id);
  expect(pages.rows(actor, first.id)[0].props[first.schema[0].id]).toEqual([pages.rows(actor, second.id)[0].id]);
  expect(searches).toBe(2); expect(mock.mock.calls.every(([,init]) => init.headers['Notion-Version'] === '2025-09-03')).toBe(true);
});
it('exports long bodies in batches of 100 blocks and rich text chunks of 2000 characters', async () => {
  vi.useFakeTimers(); const requests: any[] = [];
  const mock = vi.fn(async (input: any, init: any) => { const data = JSON.parse(init.body); requests.push({ path: new URL(String(input)).pathname, ...data }); return Response.json(data.children ? { results: data.children.map((_: any, i: number) => ({ id: 'block' + i })) } : { id: 'created', url: 'https://notion.so/created' }); });
  const page = pages.create(actor, 'wid', { title: 'Long', content: { type: 'doc', content: Array.from({ length: 105 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: 'a'.repeat(4001) }] })) } });
  const promise = new Notion(pages, actor, 'wid', 'secret', mock as typeof fetch).export(page.id, 'parent', () => {});
  await vi.runAllTimersAsync(); expect(await promise).toBe('https://notion.so/created');
  const batches = requests.filter(r => r.children); expect(batches.map(r => r.children.length)).toEqual([100, 5]);
  expect(batches[0].children[0].paragraph.rich_text.map((r: any) => r.text.content.length)).toEqual([2000, 2000, 1]);
});
it('imports recursive Notion pages and downloads images through the injected fetch', async () => {
  vi.useFakeTimers();
  const mock = vi.fn(async (input: any) => {
    const url = new URL(String(input));
    if (url.hostname === '192.0.2.1') return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname.endsWith('/search')) return Response.json({ results: [{ id: 'root', object: 'page', parent: { type: 'workspace' }, properties: { title: { type: 'title', title: [{ plain_text: 'Root' }] } } }] });
    if (/\/pages\/(root|child)$/.test(url.pathname)) return Response.json({ properties: { title: { type: 'title', title: [{ plain_text: url.pathname.endsWith('root') ? 'Root' : 'Child' }] } } });
    if (url.pathname === '/v1/blocks/root/children') return Response.json({ results: [{ id: 'child', type: 'child_page', child_page: { title: 'Child' } }, { id: 'image', type: 'image', image: { type: 'external', external: { url: 'https://192.0.2.1/image.png' }, caption: [{ plain_text: 'An image' }] } }] });
    if (url.pathname === '/v1/blocks/child/children') return Response.json({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Child body', annotations: { bold: true } }] } }] });
    throw new Error('Unexpected ' + url.pathname);
  });
  const promise = new Notion(pages, actor, 'wid', 'secret', mock as typeof fetch).import(['root'], null, () => {});
  await vi.runAllTimersAsync(); const [root] = await promise;
  const child = pages.list(actor, 'wid').find(page => page.parentId === root)!;
  expect(child.title).toBe('Child'); expect(child.content?.content?.[0].content?.[0].marks).toEqual([{ type: 'bold' }]);
  const image = pages.get(actor, root).content?.content?.find(node => node.type === 'image'); expect(image?.attrs?.src).toMatch(/^\/files\//);
  expect(pages.s.all('files')[0].mime).toBe('image/png');
});
it('validates imported dashboard data and preserves workspace layout management permissions', async () => {
  const original = pages.create(actor, 'wid', { title: 'Source' });
  const data = JSON.parse(exportPage(pages, actor, original.id, 'json'));
  const member = { ...actor, user: { ...actor.user, id: 'member', email: 'member@test.test' } };
  pages.s.put('users', member.user); pages.s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('wid', 'member', 'member', '');
  const widgets = [{ id: 'welcome', type: 'welcome', size: 'half', config: {} }];
  const attempt = (extra: any, who = actor) => importFile(pages, who, 'wid', null, 'cairn.json', strToU8(JSON.stringify({ ...data, ...extra })));
  await expect(attempt({ layouts: [{ id: 'old', workspaceId: 'old', widgets }] }, member)).rejects.toThrow('Your role');
  await expect(attempt({ stickies: [{ text: 'x'.repeat(2001) }] })).rejects.toThrow();
  await expect(attempt({ layouts: [{ id: 'old:owner', workspaceId: 'old', widgets: [{ ...widgets[0], config: { text: 'x'.repeat(21000) } }] }] })).rejects.toThrow();
  expect(pages.list(actor, 'wid')).toHaveLength(1);
  await attempt({ layouts: [{ id: 'old:owner', workspaceId: 'old', widgets }] }, member);
  expect(pages.s.get('layouts', 'wid:member').widgets).toEqual(widgets);
  expect(pages.s.get('layouts', 'wid')).toBeUndefined();
});
it('rechecks live membership and account status for direct imports and suspended async jobs', async () => {
  pages.s.put('users', { ...actor.user, disabled: true });
  await expect(importFile(pages, actor, 'wid', null, 'hello.md', strToU8('Hello'))).rejects.toThrow('no longer active');
  pages.s.put('users', actor.user);
  vi.useFakeTimers();
  const mock = vi.fn(async (input: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/search')) return Response.json({ results: [{ id: 'source', object: 'page', parent: { type: 'workspace' } }] });
    if (path.endsWith('/pages/source')) { pages.s.put('users', { ...actor.user, disabled: true }); return Response.json({ properties: { title: { type: 'title', title: [{ plain_text: 'Blocked' }] } } }); }
    throw new Error('Unexpected ' + path);
  });
  const promise = new Notion(pages, actor, 'wid', 'secret', mock as typeof fetch).import(['source'], null, () => {});
  const rejected = expect(promise).rejects.toThrow('no longer active');
  await vi.runAllTimersAsync(); await rejected;
  expect(pages.s.all('pages')).toHaveLength(0);
  expect(mock.mock.calls.every((call: any[]) => call[1].redirect === 'error')).toBe(true);
});
it('bounds rich text inside list and quote blocks without losing content', async () => {
  vi.useFakeTimers(); const batches: any[] = [];
  const mock = vi.fn(async (_input: any, init: any) => {
    const data = JSON.parse(init.body); if (data.children) batches.push(...data.children);
    return Response.json(data.children ? { results: data.children.map((_: any, index: number) => ({ id: 'block-' + index })) } : { id: 'created', url: 'https://notion.so/created' });
  });
  const text = 'a'.repeat(202001), paragraph = { type: 'paragraph', content: [{ type: 'text', text }] };
  const page = pages.create(actor, 'wid', { title: 'Long list', content: { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] }, { type: 'blockquote', content: [paragraph] }] } });
  const promise = new Notion(pages, actor, 'wid', 'secret', mock as typeof fetch).export(page.id, 'parent', () => {});
  await vi.runAllTimersAsync(); await promise;
  expect(batches.every(block => block[block.type].rich_text.length <= 100)).toBe(true);
  for (const type of ['bulleted_list_item', 'quote']) expect(batches.filter(block => block.type === type).flatMap(block => block[type].rich_text).map(rich => rich.text.content).join('')).toBe(text);
});
it('imports exported Markdown metadata without placing front matter into the body', async () => {
  const page = pages.create(actor, 'wid', { title: 'Original title', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A body' }] }] } });
  const [copy] = await importFile(pages, actor, 'wid', null, 'renamed.md', strToU8(exportPage(pages, actor, page.id, 'md')));
  expect(pages.get(actor, copy).title).toBe('Original title');
  expect(pages.get(actor, copy).content).toEqual(page.content);
});

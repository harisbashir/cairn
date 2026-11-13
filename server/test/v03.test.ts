import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { DatabaseSync } from 'node:sqlite';

describe('v0.3 pages, review and capture', () => {
  let dir: string, app: ReturnType<typeof createApp>, token: string, wid: string;
  const req = (path: string, method = 'GET', data?: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const json = async (path: string, method = 'GET', data?: unknown) => {
    const r = await req(path, method, data);
    const v: any = await r.json();
    expect(r.status, JSON.stringify(v)).toBe(200);
    return v;
  };
  const create = (data: unknown) => json(`/api/workspaces/${wid}/pages`, 'POST', data);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cairn-v03-'));
    app = createApp({ dataDir: dir });
    const r = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'X-Cairn-Client': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Owner', email: 'owner@test.com', password: 'password123', token: true }),
    });
    const b: any = await r.json();
    token = b.sessionToken;
    wid = b.workspaces[0].id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('defaults v0.2 documents and migrates links once', async () => {
    const s = new Store(dir);
    s.put('pages', {
      id: 'old',
      workspaceId: wid,
      parentId: null,
      kind: 'page',
      title: 'Old',
      content: null,
      props: {},
      schema: [],
      views: [],
    });
    s.db.exec('PRAGMA user_version=2');
    s.close();
    const migrated = new Store(dir);
    expect(migrated.db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    expect(migrated.get('pages', 'old')).toMatchObject({
      repeat: null,
      reminders: [],
      isTemplate: false,
      defaultTemplateId: null,
    });
    expect(migrated.all('users')[0].prefs).toMatchObject({
      timezone: 'UTC',
      reminderHour: 9,
      capture: null,
      notify: { mentions: true, email: false },
    });
    migrated.close();
  });
  it('uses default row templates and substitutes dates, excluding templates everywhere', async () => {
    const db = await create({ kind: 'database', title: 'Tasks', schema: [{ id: 'd', name: 'Date', type: 'date' }] });
    const row = await create({
      kind: 'row',
      parentId: db.id,
      title: 'Daily {{date}}',
      props: { d: '@today' },
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'On {{date}}' }] }] },
    });
    const template = await json(`/api/pages/${row.id}/save-as-template`, 'POST', {});
    await json(`/api/pages/${db.id}`, 'PATCH', { defaultTemplateId: template.id });
    const next = await create({ kind: 'row', parentId: db.id });
    expect(next.title).toMatch(/^Daily \d{4}-\d\d-\d\d$/);
    expect(next.props.d).toMatch(/^\d{4}-/);
    expect(JSON.stringify(next.content)).not.toContain('{{date}}');
    expect((await json(`/api/pages/${db.id}/rows`)).map((x: any) => x.id)).not.toContain(template.id);
    expect((await json(`/api/pages/${db.id}/templates`))[0].isDefault).toBe(true);
    const empty = await create({ kind: 'row', parentId: db.id, templateId: null });
    expect(empty.props).toEqual({});
    await json(`/api/pages/${template.id}`, 'DELETE');
    expect((await json(`/api/pages/${db.id}`)).defaultTemplateId).toBeNull();
  });
  it('copies page templates and their children', async () => {
    const page = await create({ title: 'Parent' });
    await create({ parentId: page.id, title: 'Child' });
    const t = await json(`/api/pages/${page.id}/save-as-template`, 'POST', { title: 'Template' });
    expect(t).toMatchObject({ isTemplate: true, parentId: null });
    const copy = await create({ templateId: t.id, title: 'Copy' });
    const tree = await json(`/api/workspaces/${wid}/tree`);
    expect(tree.nodes.some((p: any) => p.id === t.id)).toBe(false);
    expect(tree.nodes.some((p: any) => p.parentId === copy.id && p.title === 'Child')).toBe(true);
  });
  it('validates computed schemas and rejects computed and invalid file writes', async () => {
    const db = await create({
      kind: 'database',
      schema: [
        { id: 'n', name: 'Number', type: 'number' },
        { id: 'f', name: 'Double', type: 'formula', formula: { expression: 'prop("Number") * 2' } },
        { id: 'files', name: 'Files', type: 'files' },
      ],
    });
    expect(db.schema[1].formula.resultType).toBe('number');
    const row = await create({ kind: 'row', parentId: db.id, props: { n: 3 } });
    expect((await json(`/api/pages/${row.id}`)).props.f).toBe(6);
    expect((await req(`/api/pages/${row.id}`, 'PATCH', { props: { f: 7 } })).status).toBe(400);
    expect((await req(`/api/pages/${row.id}`, 'PATCH', { props: { files: ['/files/missing/a.txt'] } })).status).toBe(
      400,
    );
    expect(
      (
        await req(`/api/pages/${db.id}`, 'PATCH', {
          schema: [{ id: 'f', name: 'Broken', type: 'formula', formula: { expression: '1 +' } }],
        })
      ).status,
    ).toBe(400);
  });
  it('maintains backlinks and comment threads, with open thread counts', async () => {
    const p = await create({ title: 'Target' });
    const source = await create({
      title: 'Source',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Before ' },
              { type: 'pageLink', attrs: { pageId: p.id, title: 'Target' } },
            ],
          },
        ],
      },
    });
    expect((await json(`/api/pages/${p.id}/backlinks`))[0]).toMatchObject({ id: source.id, via: 'mention' });
    const first = await json(`/api/pages/${p.id}/comments`, 'POST', { body: 'Hello' });
    const reply = await json(`/api/pages/${p.id}/comments`, 'POST', { body: 'Reply', threadId: first.id });
    expect(reply.threadId).toBe(first.id);
    expect((await json(`/api/pages/${p.id}`)).commentCount).toBe(1);
    await json(`/api/comments/${reply.id}`, 'PATCH', { resolved: true });
    expect((await json(`/api/pages/${p.id}`)).commentCount).toBe(0);
    await json(`/api/comments/${first.id}`, 'DELETE');
    expect(await json(`/api/pages/${p.id}/comments`)).toEqual([]);
  });
  it('records changes, merges edits, detects conflicts and supports forced/batch undo', async () => {
    const p = await create({ title: 'Before' });
    await json(`/api/pages/${p.id}`, 'PATCH', { title: 'After' });
    await json(`/api/pages/${p.id}`, 'PATCH', { title: 'Latest', icon: 'x' });
    const changes = await json(`/api/workspaces/${wid}/changes?actor=all`);
    const updated = changes.find((c: any) => c.pageId === p.id && c.action === 'updated');
    const detail = await json(`/api/changes/${updated.id}`);
    expect(detail.diffs).toContainEqual({ field: 'Title', before: 'Before', after: 'Latest' });
    await json(`/api/changes/${updated.id}/undo`, 'POST', {});
    expect((await json(`/api/pages/${p.id}`)).title).toBe('Before');
    const creation = changes.find((c: any) => c.pageId === p.id && c.action === 'created');
    expect((await req(`/api/changes/${creation.id}/undo`, 'POST', {})).status).toBe(409);
    const batch = await json('/api/changes/undo', 'POST', { ids: [creation.id], force: true });
    expect(batch.undone).toContain(creation.id);
  });
  it('captures linked URL and text into a preferred database', async () => {
    const db = await create({ kind: 'database', title: 'Inbox', schema: [{ id: 'u', name: 'URL', type: 'url' }] });
    await json('/api/me', 'PATCH', { prefs: { capture: { workspaceId: wid, databaseId: db.id } } });
    const result = await json('/api/capture', 'POST', { url: 'https://example.com/article', text: 'Read this' });
    expect(result.page).toMatchObject({
      kind: 'row',
      parentId: db.id,
      title: 'example.com/article',
      props: { u: 'https://example.com/article' },
    });
    expect(JSON.stringify(result.page.content)).toContain('Read this');
  });
  it('limits notifications to the bearer workspace scope', async () => {
    const page = await create({ title: 'Visible' });
    const other = await json('/api/workspaces', 'POST', { name: 'Other' });
    const outside = await json(`/api/workspaces/${other.id}/pages`, 'POST', { title: 'Outside' });
    const store = new Store(dir);
    const user = store.all('users')[0];
    for (const p of [page, outside])
      store.put('notifications', {
        id: p.id,
        userId: user.id,
        at: new Date().toISOString(),
        kind: 'mention',
        title: p.title,
        body: 'Hello',
        pageId: p.id,
        workspaceId: p.workspaceId,
        actorName: 'Someone',
        read: false,
      });
    const scoped = await json('/api/tokens', 'POST', { name: 'Scoped', access: 'write', workspaceId: wid });
    const response = await app.request('/api/notifications', { headers: { Authorization: 'Bearer ' + scoped.secret } });
    expect(((await response.json()) as any[]).map((n) => n.id)).toEqual([page.id]);
    await app.request('/api/notifications/read', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + scoped.secret, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(store.get('notifications', outside.id).read).toBe(false);
    store.close();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import type { User } from '../../shared/types.ts';

let dir: string;
let app: ReturnType<typeof createApp>;
let cookie: string;
let workspaceId: string;
let owner: User;

async function request(path: string, method = 'GET', data?: unknown, auth = cookie) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Cairn-Client': 'permission-tests', ...(auth ? { Cookie: auth } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function json(path: string, method = 'GET', data?: unknown, auth = cookie): Promise<any> {
  const response = await request(path, method, data, auth);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function create(title: string, extra = {}) {
  return json(`/api/workspaces/${workspaceId}/pages`, 'POST', { title, ...extra });
}
async function otherUser(role?: 'member' | 'viewer') {
  await json('/api/admin/users', 'POST', { email: 'other@example.com', name: 'Other', password: 'password123' });
  const response = await request('/api/auth/login', 'POST', { email: 'other@example.com', password: 'password123' }, '');
  const auth = response.headers.get('set-cookie')!.split(';')[0];
  if (role) {
    const invite = await json(`/api/workspaces/${workspaceId}/invites`, 'POST', { role });
    await json(`/api/invites/${invite.token}/accept`, 'POST', {}, auth);
  }
  return auth;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-permission-'));
  app = createApp({ dataDir: dir });
  cookie = '';
  const response = await request('/api/auth/signup', 'POST', { email: 'owner@example.com', name: 'Owner', password: 'password123' });
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  const bootstrap = await response.json() as any;
  owner = bootstrap.user;
  workspaceId = bootstrap.workspaces[0].id;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('page permission and contract regressions', () => {
  it('conceals page existence from nonmembers on reads and writes', async () => {
    const page = await create('Concealed');
    const outsider = await otherUser();
    for (const [suffix, method, data] of [['', 'GET'], ['', 'PATCH', { title: 'No' }], ['/favorite', 'PUT'], ['/versions', 'GET'], ['/share', 'POST']] as const) {
      expect((await request(`/api/pages/${page.id}${suffix}`, method, data, outsider)).status).toBe(404);
    }
  });

  it('rejects fields reserved for other page kinds and preserves contract defaults', async () => {
    const page = await create('Document');
    const database = await create('Database', { kind: 'database' });
    const row = await create('Row', { kind: 'row', parentId: database.id });
    for (const [pageId, input] of [[page.id, { props: { x: 1 } }], [page.id, { schema: [] }], [page.id, { views: [] }], [database.id, { props: {} }], [row.id, { schema: [] }]] as const) {
      expect((await request(`/api/pages/${pageId}`, 'PATCH', input)).status).toBe(400);
    }
    expect((await request(`/api/workspaces/${workspaceId}/pages`, 'POST', { title: 'Bad', props: {} })).status).toBe(400);
    const result = await json(`/api/pages/${page.id}`);
    expect(result.props).toEqual({});
    expect(result.schema).toEqual([]);
    expect(result.views).toEqual([]);
    expect((await json(`/api/pages/${database.id}/duplicate`, 'POST')).schema).toEqual(database.schema);
  });

  it('denies viewer favorite writes and preserves each user favorite insertion order', async () => {
    const first = await create('First');
    const second = await create('Second');
    await json(`/api/pages/${second.id}/favorite`, 'PUT');
    await json(`/api/pages/${first.id}/favorite`, 'PUT');
    expect((await json(`/api/workspaces/${workspaceId}/tree`)).favorites).toEqual([second.id, first.id]);
    const result = await json(`/api/pages/${first.id}`, 'PATCH', { title: 'Renamed' });
    expect(result).not.toHaveProperty('favoriteUsers');
    expect(result).not.toHaveProperty('favoriteOrder');
    await json(`/api/pages/${second.id}/favorite`, 'DELETE');
    await json(`/api/pages/${second.id}/favorite`, 'PUT');
    expect((await json(`/api/workspaces/${workspaceId}/tree`)).favorites).toEqual([first.id, second.id]);
    const viewer = await otherUser('viewer');
    expect((await request(`/api/pages/${first.id}/favorite`, 'PUT', undefined, viewer)).status).toBe(403);
    expect((await request(`/api/pages/${first.id}/favorite`, 'DELETE', undefined, viewer)).status).toBe(403);
  });

  it('positions new pages after private siblings and rejects hidden afterId values', async () => {
    const hidden = await create('Hidden', { visibility: 'private' });
    const member = await otherUser('member');
    const appended = await json(`/api/workspaces/${workspaceId}/pages`, 'POST', { title: 'Last' }, member);
    expect(appended.position).toBeGreaterThan(hidden.position);
    expect((await request(`/api/workspaces/${workspaceId}/pages`, 'POST', { title: 'No', afterId: hidden.id }, member)).status).toBe(404);
  });

  it('snapshots browser and AI changes by the same user as different actors', async () => {
    const page = await create('Before');
    await json(`/api/pages/${page.id}`, 'PATCH', { title: 'Browser edit' });
    const store = new Store(dir);
    try {
      const pages = new Pages(store, new Events());
      pages.patch({ user: owner, actorType: 'ai', clientId: null }, page.id, { title: 'AI edit' });
      const versions = store.all<any>('versions').filter(version => version.pageId === page.id);
      expect(versions.map(version => version.title)).toEqual(['Before', 'Browser edit']);
      expect(versions.map(version => version.createdByType)).toEqual(['user', 'ai']);
    } finally { store.close(); }
  });

  it('uses the newest snapshot at tied timestamps, throttles by actor, and retains only 50', async () => {
    const page = await create('Original');
    const store = new Store(dir);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const pages = new Pages(store, new Events());
      const human = { user: owner, actorType: 'user' as const, clientId: 'browser' };
      const ai = { user: owner, actorType: 'ai' as const, clientId: null };
      pages.patch(human, page.id, { title: 'Human first' });
      pages.patch(ai, page.id, { title: 'AI first' });
      pages.patch(ai, page.id, { title: 'AI second' });
      expect(store.all<any>('versions').filter(version => version.pageId === page.id)).toHaveLength(2);
      for (let index = 0; index < 60; index++)
        pages.patch(index % 2 ? ai : human, page.id, { title: `Edit ${index}` });
      const versions = await json(`/api/pages/${page.id}/versions`);
      expect(versions).toHaveLength(50);
      expect(versions[0].title).toBe('Edit 58');
      expect(versions.at(-1).title).toBe('Edit 9');
      const activity = await json(`/api/workspaces/${workspaceId}/activity?limit=1`);
      expect(activity[0].pageTitle).toBe('Edit 59');
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it('sorts public database rows by position', async () => {
    const database = await create('Database', { kind: 'database' });
    const first = await create('First', { kind: 'row', parentId: database.id });
    const second = await create('Second', { kind: 'row', parentId: database.id });
    await json(`/api/pages/${second.id}/move`, 'POST', { parentId: database.id, afterId: null });
    const share = await json(`/api/pages/${database.id}/share`, 'POST');
    expect((await json(`/api/public/${share.token}`, 'GET', undefined, '')).rows.map((row: any) => row.id)).toEqual([second.id, first.id]);
  });

  it('indexes option names and updates search when database options are renamed', async () => {
    const database = await create('Database', { kind: 'database' });
    const status = database.schema[0];
    const option = status.options[0];
    const row = await create('Row', { kind: 'row', parentId: database.id, props: { [status.id]: option.id } });
    expect((await json(`/api/workspaces/${workspaceId}/search?q=Not%20started`))[0].id).toBe(row.id);
    option.name = 'Awaiting';
    await json(`/api/pages/${database.id}`, 'PATCH', { schema: database.schema });
    expect((await json(`/api/workspaces/${workspaceId}/search?q=Awaiting`))[0].id).toBe(row.id);
    expect(await json(`/api/workspaces/${workspaceId}/search?q=Not%20started`)).toEqual([]);
  });

  it('does not expose private relation titles through a visible row search index', async () => {
    const secret = await create('UnpublishedConfidentialPlan', { visibility: 'private' });
    const database = await create('References', {
      kind: 'database', schema: [{ id: 'relation', name: 'Related', type: 'relation' }],
    });
    await create('Visible reference', { kind: 'row', parentId: database.id, props: { relation: [secret.id] } });
    const member = await otherUser('member');
    expect(await json(`/api/workspaces/${workspaceId}/search?q=UnpublishedConfidentialPlan`, 'GET', undefined, member)).toEqual([]);
  });

  it('removes uploaded file bytes when deleting their workspace', async () => {
    const data = new FormData();
    data.set('file', new File(['content'], 'file.txt'));
    const response = await app.request(`/api/workspaces/${workspaceId}/files`, {
      method: 'POST', headers: { Cookie: cookie, 'X-Cairn-Client': 'test' }, body: data,
    });
    const { url } = await response.json() as any;
    const filePath = join(dir, 'files', url.split('/')[2]);
    expect(existsSync(filePath)).toBe(true);
    await json(`/api/workspaces/${workspaceId}`, 'DELETE');
    expect(existsSync(filePath)).toBe(false);
  });
});

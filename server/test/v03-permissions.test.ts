import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.ts';

let dir: string, app: ReturnType<typeof createApp>, cookie: string, wid: string;
async function req(path: string, method = 'GET', data?: unknown, auth = cookie, bearer = false) {
  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Cairn-Client': 'permission-tests',
      ...(bearer ? { Authorization: `Bearer ${auth}` } : { Cookie: auth }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function json(path: string, method = 'GET', data?: unknown, auth = cookie, bearer = false): Promise<any> {
  const r = await req(path, method, data, auth, bearer);
  expect([200, 201], await r.clone().text()).toContain(r.status);
  return r.json();
}
async function page(title: string, extra = {}) {
  return json(`/api/workspaces/${wid}/pages`, 'POST', { title, ...extra });
}
async function member(name: string, role: 'member' | 'viewer' | 'admin') {
  const invite = await json(`/api/workspaces/${wid}/invites`, 'POST', { role, email: `${name}@example.com` });
  const r = await req(
    '/api/auth/signup',
    'POST',
    { email: `${name}@example.com`, name, password: 'password123', inviteToken: invite.token },
    '',
  );
  expect(r.status).toBe(200);
  return r.headers.get('set-cookie')!.split(';')[0];
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-v03-permissions-'));
  app = createApp({ dataDir: dir });
  cookie = '';
  const r = await req('/api/auth/signup', 'POST', {
    email: 'owner@example.com',
    name: 'Owner',
    password: 'password123',
  });
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  wid = ((await r.json()) as any).workspaces[0].id;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('enforces comment authorship, viewer commenting, editor resolution and administrator deletion', async () => {
  const viewer = await member('Viewer', 'viewer'),
    editor = await member('Editor', 'member'),
    admin = await member('Admin', 'admin');
  const p = await page('Discussion');
  const c = await json(`/api/pages/${p.id}/comments`, 'POST', { body: 'Viewer thought', quote: 'Excerpt' }, viewer);
  expect(c).toMatchObject({
    pageId: p.id,
    threadId: c.id,
    body: 'Viewer thought',
    quote: 'Excerpt',
    resolved: false,
    createdByName: 'Viewer',
    createdByType: 'user',
  });
  const reply = await json(`/api/pages/${p.id}/comments`, 'POST', { body: 'Reply', threadId: c.id }, editor);
  expect((await req(`/api/comments/${c.id}`, 'PATCH', { body: 'Steal' }, editor)).status).toBe(403);
  expect((await req(`/api/comments/${c.id}`, 'PATCH', { resolved: true }, viewer)).status).toBe(403);
  await json(`/api/comments/${c.id}`, 'PATCH', { body: 'Edited by author' }, viewer);
  await json(`/api/comments/${reply.id}`, 'PATCH', { resolved: true }, editor);
  expect((await json(`/api/pages/${p.id}/comments`)).every((x: any) => x.resolved)).toBe(true);
  expect((await req(`/api/comments/${c.id}`, 'DELETE', undefined, editor)).status).toBe(403);
  await json(`/api/comments/${c.id}`, 'DELETE', undefined, admin);
  expect(await json(`/api/pages/${p.id}/comments`)).toEqual([]);
  const own = await json(`/api/pages/${p.id}/comments`, 'POST', { body: 'Own' }, viewer);
  await json(`/api/comments/${own.id}`, 'DELETE', undefined, viewer);
});

it('indexes link, mention and relation backlinks while concealing private and trashed sources', async () => {
  const viewer = await member('Viewer', 'viewer'),
    target = await page('Target');
  const link = await page('Link', {
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Target', marks: [{ type: 'link', attrs: { href: `/p/${target.id}` } }] }],
        },
      ],
    },
  });
  const mention = await page('Mention', {
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: target.id, title: 'Target' } }] }],
    },
  });
  const privateSource = await page('Secret', {
    visibility: 'private',
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: target.id, title: 'Target' } }] }],
    },
  });
  const db = await page('Related', { kind: 'database', schema: [{ id: 'rel', name: 'Related', type: 'relation' }] });
  const row = await page('Row', { kind: 'row', parentId: db.id, props: { rel: [target.id] } });
  const links = await json(`/api/pages/${target.id}/backlinks`, 'GET', undefined, viewer);
  expect(links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: link.id, via: 'link' }),
      expect.objectContaining({ id: mention.id, via: 'mention' }),
      expect.objectContaining({ id: row.id, via: 'relation' }),
    ]),
  );
  expect(links.some((x: any) => x.id === privateSource.id)).toBe(false);
  expect(Object.keys(links[0]).sort()).toEqual(['icon', 'id', 'kind', 'path', 'snippet', 'title', 'via']);
  await json(`/api/pages/${link.id}`, 'DELETE');
  expect((await json(`/api/pages/${target.id}/backlinks`)).some((x: any) => x.id === link.id)).toBe(false);
});

it('requires capture targets and respects bearer workspace and write scopes', async () => {
  const missing = await req('/api/capture', 'POST', { text: 'No target' });
  expect(missing.status).toBe(400);
  expect(await missing.text()).toContain('no_target');
  const read = await json('/api/tokens', 'POST', { name: 'Read capture', access: 'read', workspaceId: wid });
  const writer = await json('/api/tokens', 'POST', { name: 'Write capture', access: 'write', workspaceId: wid });
  expect((await req('/api/capture', 'POST', { workspaceId: wid, text: 'Denied' }, read.secret, true)).status).toBe(403);
  const other = await json('/api/workspaces', 'POST', { name: 'Other' });
  expect(
    (await req('/api/capture', 'POST', { workspaceId: other.id, text: 'Outside' }, writer.secret, true)).status,
  ).toBe(403);
  const captured = await json(
    '/api/capture',
    'POST',
    { workspaceId: wid, text: 'First line\nSecond line', url: 'https://example.com/article' },
    writer.secret,
    true,
  );
  expect(Object.keys(captured)).toEqual(['page']);
  expect(captured.page).toMatchObject({ workspaceId: wid, kind: 'page', title: 'example.com/article' });
});

it('records token and OAuth client names and leaves web changes unnamed', async () => {
  const token = await json('/api/tokens', 'POST', { name: 'REST Robot', access: 'write', workspaceId: wid });
  const robot = await json(`/api/workspaces/${wid}/pages`, 'POST', { title: 'Robot' }, token.secret, true);
  const web = await page('Web');
  const client = await json(
    '/oauth/register',
    'POST',
    { client_name: 'OAuth Writer', redirect_uris: ['https://client.example/callback'] },
    '',
  );
  const verifier = 'a'.repeat(64),
    challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await req(
    '/oauth/authorize?' +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: 'code',
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: 'write',
        state: 'test-state',
      }),
    'GET',
    undefined,
    '',
  );
  const request = new URL(auth.headers.get('location')!, 'http://localhost').searchParams.get('request');
  const approved = await json(`/api/oauth/requests/${request}/approve`, 'POST', { access: 'write', workspaceId: wid });
  const oauth = await json(
    '/oauth/token',
    'POST',
    {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code: new URL(approved.redirect).searchParams.get('code'),
      code_verifier: verifier,
    },
    '',
  );
  const oauthPage = await json(`/api/workspaces/${wid}/pages`, 'POST', { title: 'OAuth' }, oauth.access_token, true);
  const changes = await json(`/api/workspaces/${wid}/changes?actor=all`);
  expect(changes.find((x: any) => x.pageId === robot.id).clientName).toBe('REST Robot');
  expect(changes.find((x: any) => x.pageId === oauthPage.id).clientName).toBe('OAuth Writer');
  expect(changes.find((x: any) => x.pageId === web.id).clientName).toBeNull();
});

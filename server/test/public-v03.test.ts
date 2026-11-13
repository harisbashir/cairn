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

it('computes public database and row values without private, unshared or cross-workspace dependencies', async () => {
  const source = await page('Source', { kind: 'database', schema: [{ id: 'cost', name: 'Cost', type: 'number' }] });
  const visible = await page('Visible', { kind: 'row', parentId: source.id, props: { cost: 4 } });
  const hidden = await page('Hidden', {
    kind: 'row',
    parentId: source.id,
    visibility: 'private',
    props: { cost: 100 },
  });
  const template = await page('Template', {
    kind: 'row',
    parentId: source.id,
    isTemplate: true,
    props: { cost: 1000 },
  });
  const db = await page('Projects', {
    kind: 'database',
    schema: [
      { id: 'items', name: 'Items', type: 'relation', relationDatabaseId: source.id },
      {
        id: 'total',
        name: 'Total',
        type: 'rollup',
        rollup: { source: { kind: 'relation', propertyId: 'items' }, target: 'cost', fn: 'sum' },
      },
      { id: 'twice', name: 'Twice', type: 'formula', formula: { expression: 'prop("Total") * 2' } },
    ],
  });
  const row = await page('Project', {
    kind: 'row',
    parentId: db.id,
    props: { items: [visible.id, hidden.id, template.id] },
  });
  const share = await json(`/api/pages/${db.id}/share`, 'POST');
  const publicRead = async (token: string) => {
    const r = await app.request(`/api/public/${token}`);
    expect(r.status).toBe(200);
    return r.json() as Promise<any>;
  };
  expect((await publicRead(share.token)).rows[0].props.total).toBe(0);
  await json(`/api/pages/${source.id}/share`, 'POST');
  const response = await publicRead(share.token);
  expect(response.rows[0].props).toMatchObject({ total: 4, twice: 8 });
  const sharedRow = await json(`/api/pages/${row.id}/share`, 'POST');
  expect((await publicRead(sharedRow.token)).page.props).toMatchObject({ total: 4, twice: 8 });
});
it('centers backlink snippets on reference labels after a target rename', async () => {
  const target = await page('Renamed target');
  const filler = 'Unrelated prefix '.repeat(30);
  const source = await page('Source', {
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: filler },
            { type: 'pageLink', attrs: { pageId: target.id, title: 'Custom reference' } },
            { type: 'text', text: ' tail '.repeat(40) },
          ],
        },
      ],
    },
  });
  const links = await json(`/api/pages/${target.id}/backlinks`);
  expect(links.find((p: any) => p.id === source.id).snippet).toContain('Custom reference');
  expect(links[0].snippet.length).toBeLessThanOrEqual(120);
  const marked = await page('Marked', {
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: filler },
            { type: 'text', text: 'Marked reference', marks: [{ type: 'link', attrs: { href: `/p/${target.id}/` } }] },
          ],
        },
      ],
    },
  });
  expect((await json(`/api/pages/${target.id}/backlinks`)).find((p: any) => p.id === marked.id).snippet).toContain(
    'Marked reference',
  );
});

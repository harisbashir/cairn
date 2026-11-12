import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';

let app: ReturnType<typeof createApp>, dir: string, cookie: string, userId: string, workspaceId: string;
async function request(path: string, method = 'GET', data?: unknown) {
  return app.request(path, { method, headers: { Cookie: cookie ?? '', 'X-Cairn-Client': 'admin-delete', 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-admin-delete-'));
  app = createApp({ dataDir: dir });
  const signup = await request('/api/auth/signup', 'POST', { email: 'owner@example.com', name: 'Owner', password: 'password123' });
  cookie = signup.headers.get('set-cookie')!.split(';')[0];
  const bootstrap = await signup.json() as any;
  userId = bootstrap.user.id;
  workspaceId = bootstrap.workspaces[0].id;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('allows self-deletion when another administrator remains and revokes the session', async () => {
  const second = await request('/api/admin/users', 'POST', { email: 'other@example.com', name: 'Other', password: 'password123', isAdmin: true });
  expect(second.status).toBe(200);
  expect((await request(`/api/admin/users/${userId}`, 'DELETE')).status).toBe(200);
  expect((await request('/api/admin/users')).status).toBe(401);
  expect((await (await request('/api/bootstrap')).json() as any).user).toBeNull();
});

it('refuses self-deletion of the final administrator', async () => {
  expect((await request(`/api/admin/users/${userId}`, 'DELETE')).status).toBe(409);
  expect((await request('/api/admin/users')).status).toBe(200);
});

it('requires transferring sole ownership before self-deletion when other members remain', async () => {
  const second = await (await request('/api/admin/users', 'POST', { email: 'other@example.com', name: 'Other', password: 'password123', isAdmin: true })).json() as any;
  const invitation = await (await request(`/api/workspaces/${workspaceId}/invites`, 'POST', { role: 'member' })).json() as any;
  const login = await request('/api/auth/login', 'POST', { email: second.email, password: 'password123' });
  const ownerCookie = cookie;
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect((await request(`/api/invites/${invitation.token}/accept`, 'POST')).status).toBe(200);
  cookie = ownerCookie;
  expect((await request(`/api/admin/users/${userId}`, 'DELETE')).status).toBe(409);
  expect((await request(`/api/workspaces/${workspaceId}/members/${second.id}`, 'PATCH', { role: 'owner' })).status).toBe(200);
  expect((await request(`/api/admin/users/${userId}`, 'DELETE')).status).toBe(200);
});

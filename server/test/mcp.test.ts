import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';

describe('MCP in-process Streamable HTTP', () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let workspaceId: string;
  let secret: string;
  let requestId = 0;
  async function api(path: string, method = 'GET', data?: unknown) {
    return app.request(path, { method, headers: { Cookie: cookie ?? '', 'X-Cairn-Client': 'mcp-tests', 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  async function rpc(method: string, params: unknown = {}, token = secret) {
    const response = await app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  }
  async function call(name: string, args: unknown = {}, token = secret) {
    return (await rpc('tools/call', { name, arguments: args }, token)).result;
  }
  function result(value: any) {
    expect(value.isError).not.toBe(true);
    return JSON.parse(value.content[0].text);
  }
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cairn-mcp-'));
    app = createApp({ dataDir });
    const signup = await api('/api/auth/signup', 'POST', { email: 'owner@example.com', name: 'Owner', password: 'password123' });
    expect(signup.status).toBe(200);
    cookie = signup.headers.get('set-cookie')!.split(';')[0];
    workspaceId = (await signup.json() as any).workspaces[0].id;
    secret = (await (await api('/api/tokens', 'POST', { name: 'Writer', access: 'write' })).json() as any).secret;
  });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('initializes and exposes all 16 tools, including readable model instructions', async () => {
    const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(initialized.result.serverInfo.name).toBe('cairn');
    expect(initialized.result.instructions).toContain('Markdown');
    const tools = await rpc('tools/list');
    expect(tools.result.tools).toHaveLength(16);
    expect(result(await call('list_workspaces'))[0].id).toBe(workspaceId);
    expect((await app.request('/mcp')).status).toBe(401);
    expect((await app.request('/mcp')).headers.get('www-authenticate')).toBe('Bearer');
    const deletion = await app.request('/mcp', { method: 'DELETE', headers: { Authorization: `Bearer ${secret}` } });
    expect(deletion.status).toBe(200);
  });

  it('runs the page tools and records AI edits', async () => {
    const page = result(await call('create_page', { workspace_id: workspaceId, title: 'Knowledge', markdown: '# Body', icon: '📚' }));
    expect(page.markdown).toContain('# Body');
    const children = result(await call('list_pages', { workspace_id: workspaceId }));
    expect(children.some((p: any) => p.id === page.id)).toBe(true);
    const fetched = result(await call('get_page', { page_id: page.id }));
    expect(fetched.path).toBe('Knowledge');
    result(await call('update_page', { page_id: page.id, title: 'Updated knowledge', markdown: 'Replacement' }));
    const appended = result(await call('append_to_page', { page_id: page.id, markdown: 'Appended' }));
    expect(appended.markdown).toContain('Replacement');
    expect(appended.markdown).toContain('Appended');
    const parent = result(await call('create_page', { workspace_id: workspaceId, title: 'Parent' }));
    const moved = result(await call('move_page', { page_id: page.id, parent_id: parent.id }));
    expect(moved.parentId).toBe(parent.id);
    expect(result(await call('search', { query: 'Appen', workspace_id: workspaceId }))[0].id).toBe(page.id);
    const activity = result(await call('recent_activity', { workspace_id: workspaceId }));
    expect(activity.some((a: any) => a.actorType === 'ai' && a.pageId === page.id)).toBe(true);
    expect((await call('move_page', { page_id: parent.id, parent_id: page.id })).isError).toBe(true);
    expect((await call('delete_page', { page_id: page.id })).isError).not.toBe(true);
    expect((await call('get_page', { page_id: page.id })).isError).toBe(true);
  });

  it('runs every database tool with option names, property names and typed sorting', async () => {
    const database = result(await call('create_database', { workspace_id: workspaceId, title: 'Tasks', properties: [{ name: 'State', type: 'status', options: ['Todo', 'Done'] }, { name: 'Score', type: 'number' }, { name: 'Tags', type: 'multi_select', options: ['One'] }] }));
    expect(result(await call('get_database', { database_id: database.id })).schema[0].options[0].name).toBe('Todo');
    result(await call('update_database', { database_id: database.id, title: 'Tasks updated', add_properties: [{ name: 'Link', type: 'url' }], rename_properties: { Score: 'Priority' }, add_options: { State: ['Doing'] } }));
    const row = result(await call('create_row', { database_id: database.id, title: 'First', markdown: 'Row content', properties: { State: 'Doing', Priority: 2, Tags: ['One', 'New'] } }));
    expect(row.properties).toEqual({ State: 'Doing', Priority: 2, Tags: ['One', 'New'] });
    const next = result(await call('create_row', { database_id: database.id, title: 'Second', properties: { State: 'Done', Priority: 1 } }));
    const sorted = result(await call('query_database', { database_id: database.id, sorts: [{ property: 'Priority', dir: 'asc' }] }));
    expect(sorted.map((r: any) => r.id)).toEqual([next.id, row.id]);
    const filtered = result(await call('query_database', { database_id: database.id, filters: [{ property: 'State', op: 'eq', value: 'Doing' }] }));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].properties.State).toBe('Doing');
    const updated = result(await call('update_row', { row_id: row.id, title: 'Changed', properties: { State: 'Brand new', Priority: null }, markdown: 'Replacement row body' }));
    expect(updated.title).toBe('Changed');
    expect(updated.properties.State).toBe('Brand new');
    expect(updated.properties.Priority).toBeUndefined();
    expect(updated.markdown).toContain('Replacement row body');
    expect((await call('query_database', { database_id: database.id, view: 'Missing' })).isError).toBe(true);
  });

  it('checks inherited privacy, viewer roles and disabled users on MCP requests', async () => {
    const privatePage = await (await api(`/api/workspaces/${workspaceId}/pages`, 'POST', { title: 'Private', visibility: 'private' })).json() as any;
    const hiddenChild = await (await api(`/api/workspaces/${workspaceId}/pages`, 'POST', { title: 'Hidden child', parentId: privatePage.id })).json() as any;
    const invitation = await (await api(`/api/workspaces/${workspaceId}/invites`, 'POST', { role: 'viewer', email: 'viewer@example.com' })).json() as any;
    const signup = await api('/api/auth/signup', 'POST', { email: 'viewer@example.com', name: 'Viewer', password: 'password123', inviteToken: invitation.token });
    const viewer = (await signup.json() as any).user;
    const ownerCookie = cookie;
    cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const viewerToken = await (await api('/api/tokens', 'POST', { name: 'Viewer agent', access: 'write' })).json() as any;
    expect((await call('get_page', { page_id: hiddenChild.id }, viewerToken.secret)).isError).toBe(true);
    const visible = result(await call('list_pages', { workspace_id: workspaceId }, viewerToken.secret));
    expect(visible.some((p: any) => p.id === privatePage.id)).toBe(false);
    expect((await call('create_page', { workspace_id: workspaceId, title: 'Forbidden' }, viewerToken.secret)).isError).toBe(true);
    cookie = ownerCookie;
    expect((await api(`/api/admin/users/${viewer.id}`, 'PATCH', { disabled: true })).status).toBe(200);
    const disabled = await app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${viewerToken.secret}` } });
    expect(disabled.status).toBe(401);
  });

  it('hides and rejects write tools for read tokens and enforces workspace scopes', async () => {
    const second = await (await api('/api/workspaces', 'POST', { name: 'Other' })).json() as any;
    const foreign = await (await api(`/api/workspaces/${second.id}/pages`, 'POST', { title: 'Outside' })).json() as any;
    const readToken = await (await api('/api/tokens', 'POST', { name: 'Reader', access: 'read', workspaceId })).json() as any;
    const listed = await rpc('tools/list', {}, readToken.secret);
    expect(listed.result.tools.map((t: any) => t.name)).not.toContain('create_page');
    expect(result(await call('list_workspaces', {}, readToken.secret))).toHaveLength(1);
    expect((await call('create_page', { workspace_id: workspaceId, title: 'No' }, readToken.secret)).isError).toBe(true);
    expect((await call('get_page', { page_id: foreign.id }, readToken.secret)).isError).toBe(true);
    expect((await call('recent_activity', { workspace_id: second.id }, readToken.secret)).isError).toBe(true);
    await api('/api/tokens/'+readToken.token.id, 'DELETE');
    const revoked = await app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${readToken.secret}` } });
    expect(revoked.status).toBe(401);
  });
});

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

  it('initializes and exposes all tools, including readable model instructions', async () => {
    const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(initialized.result.serverInfo.name).toBe('cairn');
    expect(initialized.result.instructions).toContain('Markdown');
    const tools = await rpc('tools/list');
    expect(tools.result.tools).toHaveLength(42);
    expect(result(await call('list_workspaces'))[0].id).toBe(workspaceId);
    expect((await app.request('/mcp')).status).toBe(401);
    expect((await app.request('/mcp')).headers.get('www-authenticate')).toContain('Bearer resource_metadata=');
    const deletion = await app.request('/mcp', { method: 'DELETE', headers: { Authorization: `Bearer ${secret}` } });
    expect(deletion.status).toBe(200);
  });

  it('enforces the HTTP title limit before MCP creates or updates pages', async () => {
    const tooLong = 'x'.repeat(10001);
    expect((await api(`/api/workspaces/${workspaceId}/pages`, 'POST', { title: tooLong })).status).toBe(400);
    expect((await call('create_page', { workspace_id: workspaceId, title: tooLong })).isError).toBe(true);
    expect((await call('create_database', { workspace_id: workspaceId, title: tooLong, properties: [] })).isError).toBe(true);
    const page = result(await call('create_page', { workspace_id: workspaceId, title: 'Original' }));
    expect((await call('update_page', { page_id: page.id, title: tooLong })).isError).toBe(true);
    expect(result(await call('get_page', { page_id: page.id })).title).toBe('Original');
    const database = result(await call('create_database', { workspace_id: workspaceId, title: 'Database', properties: [] }));
    expect((await call('update_database', { database_id: database.id, title: tooLong })).isError).toBe(true);
    expect((await call('create_row', { database_id: database.id, title: tooLong })).isError).toBe(true);
    const row = result(await call('create_row', { database_id: database.id, title: 'Row' }));
    expect((await call('update_row', { row_id: row.id, title: tooLong })).isError).toBe(true);
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
    expect(sorted.rows.map((r: any) => r.id)).toEqual([next.id, row.id]);
    const filtered = result(await call('query_database', { database_id: database.id, filters: [{ property: 'State', op: 'eq', value: 'Doing' }] }));
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0].properties.State).toBe('Doing');
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
  it('runs v0.2 view, trash, sticky, home, image, export and calendar tools',async()=>{
    const tools=(await rpc('tools/list')).result.tools;
    for(const tool of tools)expect(tool.annotations).toMatchObject({title:expect.any(String),readOnlyHint:expect.any(Boolean),destructiveHint:expect.any(Boolean),idempotentHint:expect.any(Boolean)});
    expect(result(await call('whoami')).user.name).toBe('Owner');
    const database=result(await call('create_database',{workspace_id:workspaceId,title:'Schedule',properties:[{name:'Date',type:'date'},{name:'State',type:'select',options:['Todo','Done']}]}));
    const row=result(await call('create_row',{database_id:database.id,title:'Meeting',properties:{Date:'2026-04-02',State:'Todo'}}));
    result(await call('create_row',{database_id:database.id,title:'Later',properties:{Date:'2026-04-03'}}));
    const listed=result(await call('list_databases',{workspace_id:workspaceId}));expect(listed.find((d:any)=>d.id===database.id)).toMatchObject({title:'Schedule',rowCount:2,properties:['Date','State']});
    const queried=result(await call('query_database',{database_id:database.id,offset:1,limit:1}));expect(queried.total).toBe(2);expect(queried.rows).toHaveLength(1);
    const view=result(await call('add_view',{database_id:database.id,name:'Calendar',type:'calendar',date_property:'Date',card_properties:['State'],filters:[{property:'State',op:'eq',value:'Todo'}]}));
    expect(view.dateProp).toBe(database.schema[0].id);expect(view.filters[0].value).toBe(database.schema[1].options[0].id);
    expect(result(await call('update_view',{database_id:database.id,view:'Calendar',name:'Timeline',type:'timeline',end_date_property:'Date'})).type).toBe('timeline');
    result(await call('delete_view',{database_id:database.id,view:view.id}));
    const events=result(await call('get_calendar',{workspace_id:workspaceId,from:'2026-04-01',to:'2026-05-01'}));expect(events.map((e:any)=>e.title)).toEqual(['Meeting','Later']);
    const note=result(await call('add_sticky_note',{workspace_id:workspaceId,text:'Original',color:'pink'}));expect(result(await call('update_sticky_note',{note_id:note.id,text:'Changed'})).text).toBe('Changed');expect(result(await call('list_sticky_notes',{workspace_id:workspaceId}))[0].id).toBe(note.id);result(await call('delete_sticky_note',{note_id:note.id}));
    const widgets=[{id:'welcome',type:'welcome',size:'full',config:{}}];result(await call('set_home',{workspace_id:workspaceId,widgets}));expect(result(await call('get_home',{workspace_id:workspaceId})).widgets).toEqual(widgets);
    const child=result(await call('create_page',{workspace_id:workspaceId,parent_id:row.id,title:'Child'}));expect(result(await call('get_page',{page_id:row.id,include_children:true})).children[0].id).toBe(child.id);
    const image=result(await call('attach_image',{page_id:row.id,base64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',filename:'pixel.png',alt:'Pixel'}));expect(image.url).toContain('/files/');expect(result(await call('get_page',{page_id:row.id})).markdown).toContain('Pixel');
    expect((await call('attach_image',{page_id:row.id,base64:'SGVsbG8='})).isError).toBe(true);
    const exported=await call('export_page',{page_id:database.id,format:'csv'});expect(exported.content[0].text).toContain('Meeting,2026-04-02,Todo');
    const copy=result(await call('duplicate_page',{page_id:row.id}));expect(copy.title).toBe('Meeting copy');await call('delete_page',{page_id:copy.id});expect(result(await call('list_trash',{workspace_id:workspaceId})).some((p:any)=>p.id===copy.id)).toBe(true);expect(result(await call('restore_page',{page_id:copy.id})).id).toBe(copy.id);
    result(await call('delete_property',{database_id:database.id,property:'State'}));expect(result(await call('get_database',{database_id:database.id})).schema.map((p:any)=>p.name)).toEqual(['Date']);expect(result(await call('get_page',{page_id:row.id})).properties.State).toBeUndefined();
  });

});

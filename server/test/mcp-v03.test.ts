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

  it('exposes annotated v0.3 tools and hides writes from read tokens', async () => {
    const tools = (await rpc('tools/list')).result.tools;
    for (const name of ['list_templates','save_as_template','get_backlinks','list_comments','add_comment','list_changes','capture','add_property']) {
      expect(tools.find((t: any) => t.name === name)?.annotations.readOnlyHint).toBe(['list_templates','get_backlinks','list_comments','list_changes'].includes(name));
    }
    const read = await (await api('/api/tokens','POST',{name:'Reader',access:'read'})).json() as any;
    const names = (await rpc('tools/list',{},read.secret)).result.tools.map((t:any)=>t.name);
    for (const name of ['save_as_template','add_comment','capture','add_property']) expect(names).not.toContain(name);
  });
  it('creates formulas and files, reads computed names and rejects computed writes', async () => {
    const db = result(await call('create_database',{workspace_id:workspaceId,title:'Tasks',properties:[{name:'Amount',type:'number'},{name:'Files',type:'files'},{name:'Double',type:'formula',formula:{expression:'prop("Amount") * 2'}}]}));
    const row = result(await call('create_row',{database_id:db.id,title:'Task',properties:{Amount:3,Files:[]}}));
    expect(row.properties.Double).toBe(6);
    expect(result(await call('query_database',{database_id:db.id})).rows[0].properties.Double).toBe(6);
    expect((await call('update_row',{row_id:row.id,properties:{Double:8}})).isError).toBe(true);
  });
  it('saves and applies templates, comments, changes, backlinks and capture', async () => {
    const page=result(await call('create_page',{workspace_id:workspaceId,title:'Original',markdown:'Reusable body'}));
    const template=result(await call('save_as_template',{page_id:page.id,title:'My template'}));
    expect(result(await call('list_templates',{workspace_id:workspaceId})).some((p:any)=>p.id===template.id)).toBe(true);
    const copy=result(await call('create_page',{workspace_id:workspaceId,title:'Copy',template:'My template'}));
    expect(copy.markdown).toContain('Reusable body');
    const comment=result(await call('add_comment',{page_id:copy.id,body:'A thought',quote:'Reusable'}));
    expect(result(await call('list_comments',{page_id:copy.id})).some((c:any)=>c.id===comment.id)).toBe(true);
    expect(result(await call('get_backlinks',{page_id:copy.id}))).toEqual([]);
    const captured=result(await call('capture',{workspace_id:workspaceId,title:'Captured',text:'Quick thought'}));
    expect(captured.markdown).toContain('Quick thought');
    expect(result(await call('list_changes',{workspace_id:workspaceId})).length).toBeGreaterThan(0);
  });
  it('translates repeating rules and reminder people by name and clears them', async () => {
    const db=result(await call('create_database',{workspace_id:workspaceId,title:'Tasks',properties:[{name:'Due',type:'date'},{name:'State',type:'status',options:['Todo','Done']}]}));
    const row=result(await call('create_row',{database_id:db.id,title:'Task',properties:{Due:'2026-12-01',State:'Todo'}}));
    const updated=result(await call('update_row',{row_id:row.id,repeat:{date_property:'Due',every:1,unit:'week',done_property:'State',done_value:'Done',reset_value:'Todo'},reminders:[{date_property:'Due',minutes_before:30,people:['owner@example.com']}]}));
    expect(updated.repeat).toMatchObject({dateProp:db.schema[0].id,doneProp:db.schema[1].id,doneValue:db.schema[1].options[1].id});
    expect(updated.reminders[0]).toMatchObject({dateProp:db.schema[0].id,offsetMinutes:30,userIds:[expect.any(String)]});
    const cleared=result(await call('update_row',{row_id:row.id,repeat:null,reminders:null}));
    expect(cleared.repeat).toBeNull();expect(cleared.reminders).toEqual([]);
    expect((await call('update_row',{row_id:row.id,reminders:[{date_property:'Due',people:['Unknown']}]})).isError).toBe(true);
  });
  it('resolves rollup relation and target names', async () => {
    const target=result(await call('create_database',{workspace_id:workspaceId,title:'Items',properties:[{name:'Cost',type:'number'}]}));
    const item=result(await call('create_row',{database_id:target.id,title:'Item',properties:{Cost:7}}));
    const db=result(await call('create_database',{workspace_id:workspaceId,title:'Projects',properties:[{name:'Items',type:'relation',relation_database_id:target.id}]}));
    result(await call('add_property',{database_id:db.id,name:'Total',type:'rollup',rollup:{relation:'Items',target:'Cost',function:'sum'}}));
    const row=result(await call('create_row',{database_id:db.id,title:'Project',properties:{Items:[item.id]}}));
    expect(row.properties.Total).toBe(7);
  });

  it('resolves @me and @today when querying database filters', async () => {
    const user=result(await call('whoami')).user;
    const db=result(await call('create_database',{workspace_id:workspaceId,title:'My tasks',properties:[{name:'Assignee',type:'person'},{name:'Due',type:'date'}]}));
    const row=result(await call('create_row',{database_id:db.id,title:'Mine today',properties:{Assignee:[user.id],Due:new Date().toISOString().slice(0,10)}}));
    result(await call('create_row',{database_id:db.id,title:'Other',properties:{Due:'2001-01-01'}}));
    const queried=result(await call('query_database',{database_id:db.id,filters:[{property:'Assignee',op:'contains',value:'@me'},{property:'Due',op:'eq',value:'@today'}]}));
    expect(queried.rows.map((r:any)=>r.id)).toEqual([row.id]);
  });

});

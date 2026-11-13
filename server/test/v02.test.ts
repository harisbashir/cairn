import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { purgeExpired } from '../src/housekeeping.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';

describe('v0.2 REST contract and OAuth',()=>{
  let dir:string,app:ReturnType<typeof createApp>,session:string,wid:string,cookie:string;
  const request=(path:string,method='GET',data?:unknown,token=session,headers:Record<string,string>={})=>app.request(path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
  beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'cairn-v02-'));app=createApp({dataDir:dir});const r=await request('/api/v1/auth/signup','POST',{email:'owner@example.com',name:'Owner',password:'password123',token:true},'',{'X-Cairn-Client':'test'});const boot:any=await r.json();expect(r.status).toBe(200);expect(r.headers.get('set-cookie')).toBeNull();session=boot.sessionToken;wid=boot.workspaces[0].id;const login=await request('/api/auth/login','POST',{email:'owner@example.com',password:'password123'},'',{'X-Cairn-Client':'test'});cookie=login.headers.get('set-cookie')!.split(';')[0];});
  afterEach(()=>rmSync(dir,{recursive:true,force:true}));
  it('uses bearer sessions, stable aliases, preferences and read-only scoped API credentials',async()=>{
    expect((await (await request('/api/v1/bootstrap')).json() as any).user.prefs).toEqual({theme:'system',accent:'blue',timezone:'UTC',reminderHour:9,capture:null,notify:{push:true,email:false,mentions:true,comments:true,assigned:true}});
    expect((await request('/api/me','PATCH',{prefs:{theme:'dark'}})).status).toBe(200);
    expect((await (await request('/api/me','PATCH',{prefs:{accent:'green'}})).json() as any).prefs).toEqual({theme:'dark',accent:'green',timezone:'UTC',reminderHour:9,capture:null,notify:{push:true,email:false,mentions:true,comments:true,assigned:true}});
    expect((await request('/api/me','PATCH',{prefs:{theme:'wrong'}})).status).toBe(400);
    const read:any=await (await request('/api/tokens','POST',{name:'reader',access:'read',workspaceId:wid})).json();
    expect((await request(`/api/v1/workspaces/${wid}/tree`,'GET',undefined,read.secret)).status).toBe(200);
    expect((await request(`/api/v1/workspaces/${wid}/pages`,'POST',{title:'blocked'},read.secret)).status).toBe(403);
    expect((await request('/api/v1/admin/overview','GET',undefined,read.secret)).status).toBe(403);
    expect((await request('/api/auth/logout','POST',{},session)).status).toBe(200);
    expect((await request(`/api/workspaces/${wid}/tree`)).status).toBe(401);
  });
  it('returns empty default titles, row previews and all view fields, and reorders rows',async()=>{
    const page:any=await (await request(`/api/workspaces/${wid}/pages`,'POST',{})).json();expect(page.title).toBe('');
    const db:any=await (await request(`/api/workspaces/${wid}/pages`,'POST',{kind:'database',views:[{id:'view',name:'Calendar',type:'calendar',dateProp:'date',cardProps:['date'],filters:[],sorts:[],phone:'same',cover:'page',zoom:'week',endDateProp:'end'}]})).json();expect(db.views[0].phone).toBe('same');
    const row:any=await (await request(`/api/workspaces/${wid}/pages`,'POST',{kind:'row',parentId:db.id,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Preview'}]},{type:'image',attrs:{src:'/cover.png'}}]}})).json();
    const other:any=await (await request(`/api/workspaces/${wid}/pages`,'POST',{kind:'row',parentId:db.id})).json();
    const rows:any=await (await request(`/api/pages/${db.id}/rows`)).json();expect(rows[0]).toMatchObject({cover:'/cover.png',preview:'Preview\n',createdByName:'Owner',updatedByType:'user'});
    expect((await request(`/api/pages/${other.id}/move`,'POST',{parentId:db.id,afterId:null})).status).toBe(200);
    expect((await (await request(`/api/pages/${db.id}/rows`)).json() as any)[0].id).toBe(other.id);
    expect(row.id).toBeTruthy();
  });
  it('stores personal and workspace home layouts and validates sticky notes',async()=>{
    const url=`/api/workspaces/${wid}/home`;
    expect((await (await request(url)).json() as any).widgets.map((w:any)=>w.type)).toEqual(['welcome','recent','stickies','activity']);
    const widgets=[{id:'x',type:'note',size:'full',config:{markdown:'Hello'}}];
    expect((await (await request(url+'?scope=workspace','PUT',{widgets})).json() as any).personal).toBe(false);
    expect((await (await request(url+'?scope=personal','PUT',{widgets:[]})).json() as any).personal).toBe(true);
    expect((await (await request(url+'?scope=personal','DELETE')).json() as any).widgets).toEqual(widgets);
    expect((await request(url+'?scope=workspace','PUT',{widgets:[{...widgets[0],config:{text:'x'.repeat(21000)}}]})).status).toBe(400);
    const note:any=await (await request(`/api/workspaces/${wid}/stickies`,'POST',{text:'Test',visibility:'private'})).json();expect(note.createdByName).toBe('Owner');
    expect((await request(`/api/stickies/${note.id}`,'PATCH',{text:'x'.repeat(2001)})).status).toBe(400);
    expect((await request(`/api/stickies/${note.id}`,'DELETE')).status).toBe(200);
  });
  async function authorization(scope='write') {
    const client:any=await (await request('/oauth/register','POST',{client_name:'Test App',redirect_uris:['https://client.example/callback']},'')).json();
    const verifier='a'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
    const auth=await request('/oauth/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',code_challenge_method:'S256',code_challenge:challenge,scope,state:'state-value'}),'GET',undefined,'');
    expect(auth.status).toBe(302);const req=new URL(auth.headers.get('location')!,'http://localhost').searchParams.get('request')!;
    const info:any=await (await request('/api/oauth/requests/'+req)).json();expect(info.clientName).toBe('Test App');
    const approved:any=await (await request('/api/oauth/requests/'+req+'/approve','POST',{access:scope,workspaceId:wid})).json();
    return{client,verifier,code:new URL(approved.redirect).searchParams.get('code')!};
  }
  it('withholds invitation credentials from read-only API and OAuth tokens', async () => {
    const invite = await request(`/api/workspaces/${wid}/invites`, 'POST', { role: 'owner' });
    expect(invite.status).toBe(200);
    const reader: any = await (await request('/api/tokens', 'POST', { name: 'Reader', access: 'read', workspaceId: wid })).json();
    const { client, verifier, code } = await authorization('read');
    const oauth: any = await (await request('/oauth/token', 'POST', { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code, code_verifier: verifier }, '')).json();
    for (const token of [reader.secret, oauth.access_token]) {
      for (const prefix of ['/api', '/api/v1']) {
        expect((await request(`${prefix}/workspaces/${wid}/invites`, 'GET', undefined, token)).status).toBe(403);
      }
    }
    expect((await (await request(`/api/workspaces/${wid}/invites`)).json() as any)[0].token).toEqual(expect.any(String));
  });

  it('exchanges PKCE codes once, rotates refresh tokens, scopes REST and MCP, and revokes grants',async()=>{
    const{client,verifier,code}=await authorization('read');
    const payload={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],code,code_verifier:verifier};
    const r=await request('/oauth/token','POST',payload,'');expect(r.status).toBe(200);const tokens:any=await r.json();
    expect((await request('/oauth/token','POST',payload,'')).status).toBe(400);
    expect((await request(`/api/v1/workspaces/${wid}/tree`,'GET',undefined,tokens.access_token)).status).toBe(200);
    expect((await request(`/api/workspaces/${wid}/pages`,'POST',{},tokens.access_token)).status).toBe(403);
    const rpc=await app.request('/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});expect(rpc.status).toBe(200);const tools:any=await rpc.json();expect(tools.result.tools.some((t:any)=>t.name==='whoami')).toBe(true);expect(tools.result.tools.some((t:any)=>t.name==='set_home')).toBe(false);
    const refresh={grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token};
    const next:any=await (await request('/oauth/token','POST',refresh,'')).json();expect(next.refresh_token).not.toBe(tokens.refresh_token);expect((await request('/oauth/token','POST',refresh,'')).status).toBe(400);
    const apps:any=await (await request('/api/connected-apps')).json();expect(apps[0].clientName).toBe('Test App');expect((await request('/api/connected-apps/'+apps[0].id,'DELETE')).status).toBe(200);expect((await request(`/api/workspaces/${wid}/tree`,'GET',undefined,next.access_token)).status).toBe(401);
  });
  it('rejects failed PKCE, invalid redirects and privilege escalation during consent',async()=>{
    const {client,code}=await authorization('read');
    expect((await request('/oauth/token','POST',{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],code,code_verifier:'b'.repeat(64)},'')).status).toBe(400);
    expect((await request('/oauth/register','POST',{redirect_uris:['http://evil.example/callback']},'')).status).toBe(400);
    expect((await request('/oauth/authorize?client_id='+client.client_id+'&redirect_uri=https://evil.example')).status).toBe(400);
    expect((await request('/api/oauth/requests/missing','GET',undefined,(await (await request('/api/tokens','POST',{name:'api',access:'write'})).json() as any).secret)).status).toBe(403);
  });
  it('publishes health/OpenAPI and consistent security and CORS headers',async()=>{
    const health=await request('/api/v1/health','GET',undefined,'');expect(await health.json()).toEqual({ok:true,version:'0.2.0'});expect(health.headers.get('x-frame-options')).toBe('DENY');
    const error=await request('/api/workspaces/no/tree','GET',undefined,'');expect(error.headers.get('x-content-type-options')).toBe('nosniff');
    const schema:any=await(await request('/api/openapi.json','GET',undefined,'')).json();expect(schema.openapi).toBe('3.1.0');expect(schema.paths['/workspaces/{wid}/home'].put).toBeTruthy();expect(schema.components.schemas.User).toBeTruthy();
    process.env.CAIRN_CORS_ORIGINS='https://app.example';try{const allowed=await request('/api/health','GET',undefined,session,{Origin:'https://app.example'});expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');const denied=await request('/api/health','GET',undefined,session,{Origin:'https://evil.example'});expect(denied.headers.get('access-control-allow-origin')).toBeNull();}finally{delete process.env.CAIRN_CORS_ORIGINS;}
  });
  it('purges expired sessions, invites and 30-day trash with descendants',()=>{
    const s=new Store(dir),pages=new Pages(s,new Events());const user=s.all('users')[0],a={user,actorType:'user' as const,clientId:null};
    const parent=pages.create(a,wid,{title:'Old trash'}),child=pages.create(a,wid,{parentId:parent.id,title:'Child'});parent.deletedAt=new Date(Date.now()-31*86400000).toISOString();s.put('pages',parent);s.put('invites',{id:'old',expiresAt:'2000-01-01'});s.put('oauthCodes',{id:'old',expiresAt:'2000-01-01'});purgeExpired(s,pages);expect(s.get('pages',parent.id)).toBeUndefined();expect(s.get('pages',child.id)).toBeUndefined();expect(s.get('invites','old')).toBeUndefined();expect(s.get('oauthCodes','old')).toBeUndefined();s.close();
  });
  it('serves safe file metadata and dispositions and counts legacy files against quota',async()=>{
    const upload=async(name:string,type:string,content='hello')=>{const form=new FormData();form.set('file',new File([content],name,{type}));return app.request(`/api/v1/workspaces/${wid}/files`,{method:'POST',headers:{Authorization:'Bearer '+session},body:form});};
    const text:any=await(await upload('hello.txt','text/plain')).json();const response=await app.request(text.url+'?w=100',{headers:{Authorization:'Bearer '+session}});expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/plain');expect(response.headers.get('content-disposition')).toContain('attachment');expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const svg:any=await(await upload('image.svg','image/svg+xml','<svg/>')).json();expect((await app.request(svg.url,{headers:{Authorization:'Bearer '+session}})).headers.get('content-disposition')).toContain('attachment');
    const png:any=await(await upload('image.png','image/png','fake')).json();expect((await app.request(png.url,{headers:{Authorization:'Bearer '+session}})).headers.get('content-disposition')).toContain('inline');
    const files:any=await(await request(`/api/workspaces/${wid}/files`)).json();expect(files).toHaveLength(3);expect(files[0]).toMatchObject({createdByName:'Owner',size:4,mime:'image/png'});
    const s=new Store(dir);s.put('files',{id:'legacy',name:'old.txt',type:'text/plain',workspaceId:wid});writeFileSync(join(dir,'files','legacy'),'x'.repeat(4096));s.close();
    process.env.CAIRN_MAX_STORAGE_MB='0.001';try{expect((await upload('too-large.txt','text/plain')).status).toBe(400);}finally{delete process.env.CAIRN_MAX_STORAGE_MB;}
    expect((await request('/api/files/'+files[0].id,'DELETE')).status).toBe(200);
  });
  it('bounds JSON bodies and gives preflight requests security headers',async()=>{
    expect((await request(`/api/workspaces/${wid}/pages`,'POST',{content:'x'.repeat(2*1024*1024)})).status).toBe(400);
    process.env.CAIRN_CORS_ORIGINS='https://app.example';try{const preflight=await app.request('/api/v1/me',{method:'OPTIONS',headers:{Origin:'https://app.example','Access-Control-Request-Headers':'authorization,content-type','Access-Control-Request-Method':'PATCH'}});expect(preflight.status).toBe(204);expect(preflight.headers.get('x-content-type-options')).toBe('nosniff');expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example');}finally{delete process.env.CAIRN_CORS_ORIGINS;}
  });

});

import { beforeEach,afterEach,expect,it,describe } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { Store,now } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { registerDashboard,Dashboard } from '../src/dashboard.ts';
import { registerOAuth,oauthActor } from '../src/oauth.ts';
import { createSession,sessionActor } from '../src/auth.ts';
import { ApiException,type Actor,type Env } from '../src/common.ts';
let dir:string,s:Store,pages:Pages,actor:Actor,app:Hono<Env>;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'cairn-review-'));s=new Store(dir);pages=new Pages(s,new Events());actor={user:{id:'owner',name:'Owner',email:'owner@example.com',color:'#000000',isAdmin:true,disabled:false,createdAt:now(),lastSeenAt:null,prefs:{theme:'system',accent:'blue'}},actorType:'user',clientId:null};s.put('users',actor.user);s.put('workspaces',{id:'wid',name:'Workspace'});s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('wid','owner','owner',now());app=new Hono<Env>();app.onError((e,c)=>c.json({error:e.message},e instanceof ApiException?e.status:500));app.use('/api/*',async(c,next)=>{c.set('actor',actor);await next();});registerDashboard(app,pages);registerOAuth(app,s);});
afterEach(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
describe('review regression checks',()=>{
 it('does not use a cookie when an explicitly supplied authorization header is malformed',async()=>{
  app.get('/session',c=>c.json({actor:sessionActor(s,c)?.user.id??null}));app.post('/new-session',c=>c.json({token:createSession(s,c,actor.user.id,true)}));const {token}=await(await app.request('/new-session',{method:'POST'})).json() as {token:string};
  expect(await(await app.request('/session',{headers:{Cookie:`cairn_session=${token}`}})).json()).toEqual({actor:'owner'});
  expect(await(await app.request('/session',{headers:{Cookie:`cairn_session=${token}`,Authorization:'Basic invalid'}})).json()).toEqual({actor:null});
 });
 it('counts all visible edits this week, beyond the activity page limit',async()=>{
  const page=pages.create(actor,'wid',{title:'Public'});const secret=pages.create(actor,'wid',{title:'Private',visibility:'private'});for(let i=0;i<250;i++)s.put('activity',{id:'activity-'+i,workspaceId:'wid',actorId:'owner',at:now(),actorName:'Owner',actorType:i%2?'ai':'user',action:'updated',pageId:page.id,pageTitle:page.title,pageIcon:''});
  const response=await app.request('/api/workspaces/wid/stats');expect(await response.json()).toMatchObject({editsThisWeek:252,aiEditsThisWeek:125});
  actor={...actor,user:{...actor.user,id:'member',email:'member@example.com'}};s.put('users',actor.user);s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('wid','member','member',now());expect(await(await app.request('/api/workspaces/wid/stats')).json()).toMatchObject({editsThisWeek:251});expect(secret.visibility).toBe('private');
 });
 it('allows viewers to manage their personal dashboard while shared changes require admin',async()=>{
  s.db.prepare("UPDATE memberships SET role='viewer' WHERE userId='owner'").run();
  const d=new Dashboard(pages);expect(d.setHome(actor,'wid',[{id:'note',type:'note',size:'full',config:{markdown:'Personal'}}],true).personal).toBe(true);expect(()=>d.setHome(actor,'wid',[],false)).toThrow();
  expect((await app.request('/api/workspaces/wid/home?scope=personal',{method:'DELETE'})).status).toBe(200);
 });
 it('rejects null OAuth token payloads as invalid requests',async()=>{
  const response=await app.request('/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:'null'});expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'invalid_request'});
 });
 it('rotates refresh tokens and limits bearer access to the approved workspace',async()=>{
  const clientResponse=await app.request('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test app',redirect_uris:['https://client.example/callback']})});const client=await clientResponse.json() as {client_id:string};
  const verifier='a'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');const query=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.example/callback',response_type:'code',code_challenge_method:'S256',code_challenge:challenge,state:'csrf',scope:'write'});
  const authorization=await app.request('/oauth/authorize?'+query);const request=new URL(authorization.headers.get('location')!,'http://localhost').searchParams.get('request');const approval=await app.request(`/api/oauth/requests/${request}/approve`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access:'read',workspaceId:'wid'})});const redirect=new URL((await approval.json() as {redirect:string}).redirect);expect(redirect.searchParams.get('state')).toBe('csrf');
  const exchange=(data:Record<string,string>)=>app.request('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,...data})});
  const response=await exchange({grant_type:'authorization_code',code:redirect.searchParams.get('code')!,redirect_uri:'https://client.example/callback',code_verifier:verifier});const tokens=await response.json() as {access_token:string;refresh_token:string};expect(response.status).toBe(200);expect(oauthActor(s,'Bearer '+tokens.access_token)).toMatchObject({access:'read',workspaceId:'wid'});
  const rotated=await exchange({grant_type:'refresh_token',refresh_token:tokens.refresh_token});expect(rotated.status).toBe(200);expect((await exchange({grant_type:'refresh_token',refresh_token:tokens.refresh_token})).status).toBe(400);expect(oauthActor(s,'Bearer '+tokens.access_token)).toBeUndefined();
 });
 it('migrates version-one data, defaults new fields and replaces raw-id search entries',()=>{
  const db=pages.create(actor,'wid',{kind:'database',title:'Tasks',schema:[{id:'status',name:'Status',type:'select',options:[{id:'rawsecretoption',name:'Finished',color:'green'}]}]});
  const row=pages.create(actor,'wid',{kind:'row',parentId:db.id,title:'Legacy',props:{status:'rawsecretoption'}});
  const oldUser={...actor.user} as Record<string,unknown>;delete oldUser.prefs;s.put('users',oldUser as {id:string});
  const oldPage={...row} as Record<string,unknown>;delete oldPage.cover;delete oldPage.updatedByType;s.put('pages',oldPage as {id:string});
  s.db.prepare('UPDATE search SET body=? WHERE id=?').run('rawsecretoption',row.id);s.db.exec('PRAGMA user_version=1');s.close();s=new Store(dir);
  expect(s.get('users','owner')?.prefs).toEqual({theme:'system',accent:'blue',timezone:'UTC',reminderHour:9,capture:null,notify:{push:true,email:false,mentions:true,comments:true,assigned:true}});expect(s.get('pages',row.id)).toMatchObject({cover:'',updatedByType:'user'});expect(s.db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
  expect(s.db.prepare("SELECT id FROM search WHERE search MATCH 'rawsecretoption'").all()).toEqual([]);expect(s.db.prepare("SELECT id FROM search WHERE search MATCH 'Finished'").all()).toEqual([{id:row.id}]);
 });
 it('rejects invalid PKCE and one-time code replay',async()=>{
  s.put('oauthClients',{id:'test-client',client_name:'Test',redirect_uris:['https://client.example/callback']});
  const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
  const {hashSecret}=await import('../src/auth.ts');
  s.put('oauthCodes',{id:hashSecret('authorization-secret'),userId:'owner',clientId:'test-client',redirectUri:'https://client.example/callback',challenge,access:'write',workspaceId:null,expiresAt:new Date(Date.now()+60000).toISOString()});
  const exchange=(code_verifier:string)=>app.request('/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'test-client',grant_type:'authorization_code',code:'authorization-secret',redirect_uri:'https://client.example/callback',code_verifier})});
  expect((await exchange('x'.repeat(43))).status).toBe(400);expect((await exchange(verifier)).status).toBe(400);expect(s.all('oauthGrants')).toEqual([]);
 });

});

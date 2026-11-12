import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.ts';
let dataDir:string, app:ReturnType<typeof createApp>,cookie:string,wid:string;
const api=(path:string,method='GET',data?:unknown,auth=cookie)=>app.request(path,{method,headers:{Cookie:auth,'X-Cairn-Client':'event-tab','Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
beforeEach(async()=>{
 dataDir=mkdtempSync(join(tmpdir(),'cairn-events-'));app=createApp({dataDir});
 const r=await api('/api/auth/signup','POST',{name:'Owner',email:'owner@example.com',password:'password123'},'');
 cookie=r.headers.get('set-cookie')!.split(';')[0];wid=(await r.json() as any).workspaces[0].id;
});
afterEach(()=>{vi.useRealTimers();rmSync(dataDir,{recursive:true,force:true});});
it('streams workspace changes with client ids, pings and cancellation',async()=>{
 const response=await api(`/api/workspaces/${wid}/events`);
 expect(response.headers.get('content-type')).toContain('text/event-stream');
 const reader=response.body!.getReader();
 try {
   const pending=reader.read();
   const p=await (await api(`/api/workspaces/${wid}/pages`,'POST',{title:'Live'})).json() as any;
   const chunk=await pending;const text=new TextDecoder().decode(chunk.value);
   expect(text).toContain('data: ');const e=JSON.parse(text.slice(6).trim());
   expect(e).toMatchObject({type:'page',pageId:p.id,clientId:'event-tab',actorType:'user',change:'created'});
 } finally {await reader.cancel();}
});
it('does not deliver inherited private page changes to other members',async()=>{
 const invite=await (await api(`/api/workspaces/${wid}/invites`,'POST',{role:'member'})).json() as any;
 const signup=await api('/api/auth/signup','POST',{name:'Other',email:'other@example.com',password:'password123',inviteToken:invite.token},'');
 const other=signup.headers.get('set-cookie')!.split(';')[0];
 const response=await api(`/api/workspaces/${wid}/events`,'GET',undefined,other);
 const reader=response.body!.getReader();
 try {
   const pending=reader.read();
   const privatePage=await (await api(`/api/workspaces/${wid}/pages`,'POST',{title:'Private',visibility:'private'})).json() as any;
   await api(`/api/workspaces/${wid}/pages`,'POST',{title:'Private child',parentId:privatePage.id});
   const pub=await (await api(`/api/workspaces/${wid}/pages`,'POST',{title:'Public'})).json() as any;
   const text=new TextDecoder().decode((await pending).value);
   expect(JSON.parse(text.slice(6).trim()).pageId).toBe(pub.id);
 } finally {await reader.cancel();}
});
it('emits a ping every 25 seconds and closes when its session is revoked',async()=>{
 vi.useFakeTimers();
 const response=await api(`/api/workspaces/${wid}/events`);
 const reader=response.body!.getReader();
 try {
   const pending=reader.read();await vi.advanceTimersByTimeAsync(25000);
   expect(new TextDecoder().decode((await pending).value)).toContain('"type":"ping"');
   await api('/api/auth/logout','POST');
   const ended=reader.read();await vi.advanceTimersByTimeAsync(25000);
   expect((await ended).done).toBe(true);
 } finally {await reader.cancel();}
});

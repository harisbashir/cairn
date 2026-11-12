import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Store, now } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { Calendars, registerCalendars } from '../src/calendars.ts';
import { parseICS } from '../src/ics.ts';
import { blockedAddress, safeDownload } from '../src/outbound.ts';
import { ApiException, type Actor, type Env } from '../src/common.ts';
const ics=(body:string)=>`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const base='UID:abc\r\nSUMMARY:Planning\\, launch\r\nLOCATION:Office\\nRoom 2\r\n';
describe('ICS parser',()=>{
 it('unfolds and unescapes lines, reads dates and UTC timestamps',()=>{
  const events=parseICS(ics(base+'DTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261103\r\nSUMMARY:Long\r\n  title'),'2026-11-01','2026-12-01');
  expect(events[0]).toMatchObject({uid:'abc',title:'Planning, launch',start:'2026-11-01',end:'2026-11-03',allDay:true,location:'Office\nRoom 2'});
  expect(parseICS(ics('SUMMARY:Long\r\n  title\r\nDTSTART:20261101T143000Z\r\nDTEND:20261101T153000Z'),'2026-11-01','2026-11-02')[0]).toMatchObject({title:'Long title',start:'2026-11-01T14:30:00.000Z',end:'2026-11-01T15:30:00.000Z',allDay:false});
 });
 it('counts daily occurrences before window and excludes exceptions',()=>{
  const text=ics(base+'DTSTART;VALUE=DATE:20261030\r\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=5\r\nEXDATE;VALUE=DATE:20261101,20261105');
  expect(parseICS(text,'2026-11-01','2026-12-01').map(e=>e.start)).toEqual(['2026-11-03','2026-11-07']);
 });
 it('expands weekly BYDAY, interval and inclusive UNTIL',()=>{
  const text=ics('DTSTART;VALUE=DATE:20261102\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261118');
  expect(parseICS(text,'2026-11-01','2026-12-01').map(e=>e.start)).toEqual(['2026-11-02','2026-11-04','2026-11-16','2026-11-18']);
 });
 it('skips missing month days and non-leap years',()=>{
  expect(parseICS(ics('DTSTART;VALUE=DATE:20260131\r\nRRULE:FREQ=MONTHLY;COUNT=3'),'2026-01-01','2026-06-01').map(e=>e.start)).toEqual(['2026-01-31','2026-03-31','2026-05-31']);
  expect(parseICS(ics('DTSTART;VALUE=DATE:20240229\r\nRRULE:FREQ=YEARLY;COUNT=2'),'2028-01-01','2029-01-01').map(e=>e.start)).toEqual(['2028-02-29']);
 });
 it('preserves wall time over daylight saving and applies timezone EXDATE',()=>{
  const text=ics('DTSTART;TZID=America/Toronto:20261031T090000\r\nDTEND;TZID=America/Toronto:20261031T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;TZID=America/Toronto:20261102T090000');
  expect(parseICS(text,'2026-10-31','2026-11-04').map(e=>[e.start,e.end])).toEqual([['2026-10-31T13:00:00.000Z','2026-10-31T14:00:00.000Z'],['2026-11-01T14:00:00.000Z','2026-11-01T15:00:00.000Z']]);
 });
 it('includes overlapping events and ignores bad events',()=>{
  expect(parseICS(ics('DTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261102'),'2026-11-01','2026-11-02')).toHaveLength(1);
  expect(parseICS(ics('DTSTART;TZID=Bad/Zone:20261101T090000'),'2026-11-01','2026-11-02')).toEqual([]);
 });
});
describe('outbound downloads',()=>{
 it('rejects dangerous addresses including mapped IPv6',async()=>{
  for(const ip of ['127.0.0.1','127.8.2.3','169.254.1.1','::1','fe80::1','::ffff:7f00:1','0.0.0.0']) expect(blockedAddress(ip),ip).toBe(true);
  for(const ip of ['192.168.1.1','10.0.0.1','172.16.2.4','8.8.8.8','fd00::1']) expect(blockedAddress(ip),ip).toBe(false);
  const fetcher=vi.fn();await expect(safeDownload('http://127.0.0.1/private',fetcher)).rejects.toThrow('Loopback');expect(fetcher).not.toHaveBeenCalled();
 });
 it('validates redirects and enforces streamed and advertised byte limits',async()=>{
  const redirect=vi.fn(async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1'}}));
  await expect(safeDownload('https://8.8.8.8',redirect)).rejects.toThrow('Loopback');expect(redirect).toHaveBeenCalledTimes(1);
  await expect(safeDownload('https://8.8.8.8',async()=>new Response('1234'),3)).rejects.toThrow('size');
  await expect(safeDownload('https://8.8.8.8',async()=>new Response('',{headers:{'content-length':'400'}}),3)).rejects.toThrow('size');
  expect(new TextDecoder().decode((await safeDownload('http://127.0.0.1',async()=>new Response('ok'),5,true)).data)).toBe('ok');
 });
});
let dir:string,s:Store,pages:Pages,owner:Actor,other:Actor,viewer:Actor,wid:string,service:Calendars;
function actor(id:string):Actor { const user={id,email:id+'@example.com',name:id,color:'#123456',isAdmin:false,disabled:false,createdAt:now(),lastSeenAt:null,prefs:{theme:'system' as const,accent:'blue' as const}};s.put('users',user);return {user,actorType:'user',clientId:null}; }
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'cairn-calendars-'));s=new Store(dir);pages=new Pages(s,new Events());wid='workspace';s.put('workspaces',{id:wid,name:'Workspace'});owner=actor('owner');other=actor('other');viewer=actor('viewer');for(const [a,role] of [[owner,'owner'],[other,'member'],[viewer,'viewer']] as const)s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(wid,a.user.id,role,now());service=new Calendars(pages,vi.fn(async()=>new Response(ics(base+'DTSTART;VALUE=DATE:20261104'))));});
afterEach(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
function database(a=owner,visibility:'private'|'workspace'='workspace'){return pages.create(a,wid,{title:'Tasks',kind:'database',visibility,schema:[{id:'due',name:'Due',type:'date'},{id:'next',name:'Next',type:'date'}]});}
function row(db:string,title='Task',a=owner,extra={}){return pages.create(a,wid,{parentId:db,kind:'row',title,props:{due:'2026-11-03',next:'2026-11-05T09:30:00Z'},...extra});}
describe('calendars and private feeds',()=>{
 it('returns one event per date property and respects private ancestors and trash',async()=>{
  const db=database();row(db.id);row(database(owner,'private').id,'Secret');const hidden=row(db.id,'Private',owner,{visibility:'private'});const trash=database();row(trash.id,'Trashed');pages.remove(owner,trash.id);
  const events=await service.events(other,wid,'2026-11-01','2026-12-01');expect(events).toHaveLength(2);expect(events.map(e=>e.title)).toEqual(['Task','Task']);expect(events[0]).toMatchObject({source:'row',calendarName:'Tasks',start:'2026-11-03',allDay:true});
  expect((await service.events(owner,wid,'2026-11-01','2026-12-01'))).toHaveLength(6);
  expect(()=>service.rowEvents({...owner,workspaceId:'elsewhere'},wid)).toThrow();expect(hidden.visibility).toBe('private');
 });
 it('caches external ICS, masks addresses and rejects viewer edits and invalid windows',async()=>{
  const cal=await service.create(other,wid,{name:'Remote',url:'webcal://8.8.8.8/private-token',color:'green'});expect(cal.url).toBe('https://8.8.8.8');expect(service.list(owner,wid)[0].url).toContain('private-token');
  expect(await service.events(viewer,wid,'2026-11-01','2026-12-01')).toHaveLength(1);await service.events(owner,wid,'2026-11-01','2026-12-01');expect(service.fetchImpl).toHaveBeenCalledTimes(1);expect(service.list(owner,wid)[0].lastSyncedAt).toBeTruthy();
  await expect(service.create(viewer,wid,{name:'No',url:'https://8.8.8.8'})).rejects.toThrow();expect(()=>service.remove(viewer,wid,cal.id)).toThrow();
  await expect(service.events(owner,wid,'2026-02-30','2026-03-02')).rejects.toThrow();await expect(service.events(owner,wid,'2026-01-01','2028-01-01')).rejects.toThrow();service.remove(other,wid,cal.id);expect(service.list(owner,wid)).toEqual([]);
 });
 it('records sync errors and keeps a successful stale cache',async()=>{
  const cal=await service.create(owner,wid,{name:'Remote',url:'https://8.8.8.8'});await service.events(owner,wid,'2026-11-01','2026-12-01');const stored=s.get('calendars',cal.id)!;stored.checkedAt='2000-01-01';s.put('calendars',stored);service.fetchImpl=vi.fn(async()=>{throw new Error('Offline');});expect(await service.events(owner,wid,'2026-11-01','2026-12-01')).toHaveLength(1);expect(service.list(owner,wid)[0].lastError).toBe('Offline');
 });
 it('creates stable, revocable per-user feeds, emits escaped all-day events and checks membership',()=>{
  const db=database();const r=row(db.id,'Hello, world;\nNext');row(database(owner,'private').id,'Secret');const feed=service.feed(other,wid,true)!;expect(service.feed(other,wid,true)?.token).toBe(feed.token);const text=service.render(feed.token,'https://cairn.example');expect(text).toContain('DTSTART;VALUE=DATE:20261103\r\nDTEND;VALUE=DATE:20261104');expect(text).toContain('SUMMARY:Hello\\, world\\;\\nNext');expect(text).toContain(`UID:row:${r.id}:due@cairn`);expect(text).not.toContain('Secret');expect(text).toContain('https://cairn.example/');
  expect(()=>service.feed({...other,access:'read'},wid,true)).toThrow();s.db.prepare('DELETE FROM memberships WHERE workspaceId=? AND userId=?').run(wid,other.user.id);expect(()=>service.render(feed.token,'https://example.com')).toThrow();service.revoke(owner,wid);s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(wid,other.user.id,'member',now());service.revoke(other,wid);expect(()=>service.render(feed.token,'https://example.com')).toThrow();
 });
 it('registers REST routes and serves public feeds with the correct media type',async()=>{
  const app=new Hono<Env>();app.onError((err,c)=>c.json({error:err.message},err instanceof ApiException?err.status:500));app.use('/api/*',async(c,next)=>{c.set('actor',owner);await next();});registerCalendars(app,pages,service.fetchImpl);row(database().id);
  const feedResponse=await app.request(`/api/workspaces/${wid}/calendar-feed`,{method:'POST'});expect(feedResponse.status).toBe(200);const feed=await feedResponse.json() as {url:string};const response=await app.request(new URL(feed.url).pathname);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/calendar');expect(await response.text()).toContain('BEGIN:VEVENT');
  expect((await app.request(`/api/workspaces/${wid}/calendar-events?from=2026-11-01&to=2026-12-01`)).status).toBe(200);
 });
});

it('enforces the download timeout even if an injected fetch ignores abort',async()=>{
  vi.useFakeTimers();
  try {
    const promise=safeDownload('https://127.0.0.1/calendar.ics', (()=>new Promise<Response>(()=>{})) as typeof fetch,100,true);
    const failure=expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10000);
    await failure;
  } finally { vi.useRealTimers(); }
});

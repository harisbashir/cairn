import type { Hono } from 'hono';
import { z } from 'zod';
import type { CalendarEvent, ExternalCalendar, OptionColor, User } from '../../shared/types.ts';
import { body, fail, membership, publicUrl, publicUser, type Actor, type Env } from './common.ts';
import { id, now } from './db.ts';
import type { Pages } from './pages.ts';
import { parseICS, icsEscape } from './ics.ts';
import { safeDownload, validateOutboundUrl } from './outbound.ts';
const colors = ['gray','brown','orange','yellow','green','teal','blue','purple','pink','red'] as const;
interface StoredCalendar extends ExternalCalendar { workspaceId: string; content?: string; checkedAt?: string }
interface Feed { id: string; workspaceId: string; userId: string; token: string }
const day = 86400000;
function color(key: string): OptionColor { return colors[Array.from(key).reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0)%colors.length]; }
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value; }
export class Calendars {
  private pending = new Map<string,Promise<StoredCalendar>>();
  constructor(public pages: Pages, public fetchImpl: typeof fetch = fetch) {}
  list(actor: Actor, wid: string): ExternalCalendar[] {
    const member = membership(this.pages.s,actor,wid);
    return this.pages.s.all<StoredCalendar>('calendars').filter(c=>c.workspaceId===wid).map(c=>this.external(c,['owner','admin'].includes(member.role)));
  }
  private external(c: StoredCalendar, admin: boolean): ExternalCalendar {
    return {id:c.id,name:c.name,color:c.color,url:admin ? c.url : new URL(c.url).origin,lastSyncedAt:c.lastSyncedAt,lastError:c.lastError};
  }
  async create(actor: Actor,wid: string,input: {name:string;url:string;color?:OptionColor}): Promise<ExternalCalendar> {
    const member = membership(this.pages.s,actor,wid,true);
    let url: URL; try { url=await validateOutboundUrl(input.url); } catch(error) { return fail(400,(error as Error).message); }
    const calendar: StoredCalendar={id:id(),workspaceId:wid,name:input.name,url:url.href,color:input.color??'blue',lastSyncedAt:null,lastError:null};
    this.pages.s.put('calendars',calendar);
    return this.external(calendar,['owner','admin'].includes(member.role));
  }
  remove(actor: Actor,wid: string,calendarId: string): void {
    membership(this.pages.s,actor,wid,true);
    const calendar=this.pages.s.get<StoredCalendar>('calendars',calendarId);
    if(!calendar || calendar.workspaceId!==wid) fail(404,'Calendar not found.');
    this.pages.s.remove('calendars',calendarId);
  }
  rowEvents(actor: Actor,wid: string,from?: string,to?: string): CalendarEvent[] {
    const pages=this.pages.list(actor,wid); const databases=new Map(pages.filter(p=>p.kind==='database').map(p=>[p.id,p]));
    return pages.filter(p=>p.kind==='row'&&!this.pages.isTemplate(p)).flatMap(row=>{
      const database=databases.get(row.parentId??''); if(!database) return [];
      return database.schema.filter(p=>p.type==='date').flatMap(property=>{
        const start=row.props[property.id]; if(typeof start!=='string' || !start || !Number.isFinite(Date.parse(start))) return [];
        const allDay=/^\d{4}-\d{2}-\d{2}$/.test(start);
        if((from && Date.parse(start)<Date.parse(from)) || (to && Date.parse(start)>=Date.parse(to))) return [];
        return [{id:`row:${row.id}:${property.id}`,title:row.title,start:allDay?start:new Date(start).toISOString(),end:null,allDay,source:'row' as const,color:color(database.id),calendarName:database.title,pageId:row.id,location:''}];
      });
    });
  }
  private async sync(calendar: StoredCalendar): Promise<StoredCalendar> {
    if(calendar.checkedAt && Date.now()-Date.parse(calendar.checkedAt)<15*60_000) return calendar;
    const existing=this.pending.get(calendar.id); if(existing) return existing;
    const pending=(async()=>{
      calendar.checkedAt=now();
      try { const response=await safeDownload(calendar.url,this.fetchImpl); calendar.content=new TextDecoder().decode(response.data); calendar.lastSyncedAt=now(); calendar.lastError=null; }
      catch(error) { calendar.lastError=(error as Error).message.replace(/https?:\/\/[^\s]+/gi,'[remote URL]').slice(0,500); }
      if(this.pages.s.get('calendars',calendar.id)) this.pages.s.put('calendars',calendar);
      return calendar;
    })();
    this.pending.set(calendar.id,pending);
    try { return await pending; } finally { this.pending.delete(calendar.id); }
  }
  async events(actor: Actor,wid: string,from: string,to: string): Promise<CalendarEvent[]> {
    membership(this.pages.s,actor,wid);
    if(!validDate(from) || !validDate(to) || Date.parse(to)<=Date.parse(from) || Date.parse(to)-Date.parse(from)>400*day) fail(400,'Use a valid date window of at most 400 days.');
    const calendars=await Promise.all(this.pages.s.all<StoredCalendar>('calendars').filter(c=>c.workspaceId===wid).map(c=>this.sync(c)));
    const result=this.rowEvents(actor,wid,from,to);
    for(const c of calendars) for(const event of parseICS(c.content??'',from,to)) result.push({id:`external:${c.id}:${event.uid}:${event.start}`,title:event.title,start:event.start,end:event.end,allDay:event.allDay,source:'external',color:c.color,calendarName:c.name,pageId:null,location:event.location});
    return result.sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
  }
  feed(actor: Actor,wid: string,create=false): Feed | undefined {
    membership(this.pages.s,actor,wid);
    if(create && actor.access==='read') fail(403,'Read-only tokens cannot create feeds.');
    let feed=this.pages.s.all<Feed>('feeds').find(f=>f.workspaceId===wid && f.userId===actor.user.id);
    if(!feed && create) { feed={id:id(),workspaceId:wid,userId:actor.user.id,token:id()+id()};this.pages.s.put('feeds',feed); }
    return feed;
  }
  revoke(actor: Actor,wid: string): void { if(actor.access==='read') fail(403,'Read-only tokens cannot revoke feeds.'); const feed=this.feed(actor,wid); if(feed) this.pages.s.remove('feeds',feed.id); }
  render(token: string,baseUrl: string): string {
    const feed=this.pages.s.all<Feed>('feeds').find(f=>f.token===token);
    const user=feed && this.pages.s.get<User>('users',feed.userId);
    if(!feed || !user || user.disabled) return fail(404,'Calendar feed not found.');
    const actor: Actor={user:publicUser(user),actorType:'user',clientId:null};
    // Revoked membership invalidates subscriptions immediately.
    const member=this.pages.s.db.prepare('SELECT 1 FROM memberships WHERE workspaceId=? AND userId=?').get(feed.workspaceId,user.id);
    if(!member) return fail(404,'Calendar feed not found.');
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Cairn//Calendar//EN','CALSCALE:GREGORIAN'];
    for(const event of this.rowEvents(actor,feed.workspaceId)) {
      const date=(value: string)=>value.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
      lines.push('BEGIN:VEVENT',`UID:${event.id}@cairn`,`DTSTAMP:${date(now())}`,`SUMMARY:${icsEscape(event.title)}`);
      lines.push(`DTSTART${event.allDay?';VALUE=DATE':''}:${date(event.start)}`);
      if(event.allDay) lines.push(`DTEND;VALUE=DATE:${date(new Date(Date.parse(event.start)+day).toISOString().slice(0,10))}`);
      lines.push(`URL:${baseUrl.replace(/\/$/,'')}/w/${feed.workspaceId}/p/${event.pageId}`,'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    // RFC 5545's 75-octet folding, preserving UTF-8 code points.
    return lines.map(line=>{let result='',bytes=0;for(const c of line){const size=Buffer.byteLength(c);if(bytes+size>75){result+='\r\n ';bytes=1;}result+=c;bytes+=size;}return result;}).join('\r\n')+'\r\n';
  }
}
export function registerCalendars(app: Hono<Env>,pages: Pages,fetchImpl: typeof fetch=fetch): Calendars {
  const calendars=new Calendars(pages,fetchImpl);
  app.get('/api/workspaces/:wid/calendars',c=>c.json(calendars.list(c.get('actor'),c.req.param('wid'))));
  app.post('/api/workspaces/:wid/calendars',async c=>{const input=await body(c,z.object({name:z.string().trim().min(1).max(200),url:z.string().min(1).max(4000),color:z.enum(colors).optional()}));return c.json(await calendars.create(c.get('actor'),c.req.param('wid'),input));});
  app.delete('/api/workspaces/:wid/calendars/:id',c=>{calendars.remove(c.get('actor'),c.req.param('wid'),c.req.param('id'));return c.json({ok:true});});
  app.get('/api/workspaces/:wid/calendar-events',async c=>c.json(await calendars.events(c.get('actor'),c.req.param('wid'),c.req.query('from')??'',c.req.query('to')??'')));
  app.get('/api/workspaces/:wid/calendar-feed',c=>{const feed=calendars.feed(c.get('actor'),c.req.param('wid'));return c.json({url:feed?publicUrl(c,`/cal/${feed.token}.ics`):null});});
  app.post('/api/workspaces/:wid/calendar-feed',c=>{const feed=calendars.feed(c.get('actor'),c.req.param('wid'),true)!;return c.json({url:publicUrl(c,`/cal/${feed.token}.ics`)});});
  app.delete('/api/workspaces/:wid/calendar-feed',c=>{calendars.revoke(c.get('actor'),c.req.param('wid'));return c.json({ok:true});});
  app.get('/cal/:token',c=>{const token=c.req.param('token');if(!token.endsWith('.ics')) return fail(404,'Calendar feed not found.'); c.header('Content-Type','text/calendar; charset=utf-8');c.header('Cache-Control','private, no-cache');return c.body(calendars.render(token.slice(0,-4),publicUrl(c)));});
  return calendars;
}

import type { Hono } from 'hono';
import { z } from 'zod';
import { body, fail, membership, type Actor, type Env } from './common.ts';
import { id, now } from './db.ts';
import type { Pages } from './pages.ts';
import type { HomeLayout, Sticky, Widget } from '../../shared/types.ts';

export const widgetsSchema = z.array(z.object({
  id: z.string().min(1), type: z.enum(['welcome','recent','favorites','activity','stickies','view','page','note','links','calendar','stats','notifications','changes']),
  title: z.string().max(1000).optional(), size: z.enum(['third','half','two-thirds','full']),
  config: z.record(z.string(), z.unknown()).refine(v => Buffer.byteLength(JSON.stringify(v)) <= 20480, 'Widget config exceeds 20 KB.'),
})).max(30).refine(v => new Set(v.map(w => w.id)).size === v.length, 'Widget ids must be unique.');
export const stickyInput = z.object({ text: z.string().max(2000).optional(), color: z.enum(['yellow','pink','blue','green','purple','orange','gray']).optional(), visibility: z.enum(['private','workspace']).optional(), afterId: z.string().nullable().optional() });
const defaultWidgets: Widget[] = [
  { id: 'welcome', type: 'welcome', size: 'full', config: {} },
  { id: 'recent', type: 'recent', size: 'full', config: {} },
  { id: 'stickies', type: 'stickies', size: 'half', config: {} },
  { id: 'activity', type: 'activity', size: 'half', config: {} },
];
export class Dashboard {
  constructor(public pages: Pages) {}
  home(a: Actor, wid: string): HomeLayout {
    const m = membership(this.pages.s, a, wid);
    const personal = this.pages.s.get('layouts', wid + ':' + a.user.id);
    return { widgets: personal?.widgets ?? this.pages.s.get('layouts', wid)?.widgets ?? defaultWidgets, personal: !!personal, canEditShared: ['owner','admin'].includes(m.role) && a.access !== 'read' };
  }
  setHome(a: Actor, wid: string, widgets: unknown, personal = false) {
    membership(this.pages.s, a, wid, !personal, !personal);
    if (a.access === 'read') fail(403, 'Read-only tokens cannot change layouts.');
    const parsed = widgetsSchema.safeParse(widgets);
    if (!parsed.success) fail(400, 'Invalid widgets.');
    this.pages.s.put('layouts', { id: personal ? wid + ':' + a.user.id : wid, workspaceId: wid, widgets: parsed.data });
    this.pages.events.emit(wid, { type: 'home' });
    return this.home(a, wid);
  }
  stickies(a: Actor, wid: string): Sticky[] {
    membership(this.pages.s, a, wid);
    return this.pages.s.all<Sticky>('stickies').filter(n => n.workspaceId === wid && (n.visibility === 'workspace' || n.createdBy === a.user.id)).sort((a,b) => a.position - b.position);
  }
  sticky(a: Actor, key: string): Sticky {
    const n = this.pages.s.get<Sticky>('stickies', key) ?? fail(404, 'Note not found.');
    membership(this.pages.s, a, n.workspaceId, true);
    if (n.visibility === 'private' && n.createdBy !== a.user.id) fail(404, 'Note not found.');
    return n;
  }
  add(a: Actor, wid: string, input: unknown) {
    membership(this.pages.s, a, wid, true);
    const v = stickyInput.parse(input);
    const note: Sticky = { id: id(), workspaceId: wid, text: v.text ?? '', color: v.color ?? 'yellow', visibility: v.visibility ?? 'workspace', position: (this.stickies(a,wid)[0]?.position ?? 1)-1, createdBy: a.user.id, createdByName: a.user.name, createdByType: a.actorType, createdAt: now(), updatedAt: now() };
    this.pages.s.put('stickies', note); this.pages.events.emit(wid, { type: 'stickies' }); return note;
  }
  update(a: Actor, key: string, input: unknown) {
    const n = this.sticky(a,key), v = stickyInput.parse(input);
    if (v.visibility !== undefined && n.createdBy !== a.user.id) fail(403, 'Only the author can change visibility.');
    if (v.afterId !== undefined) {
      const notes = this.stickies(a,n.workspaceId).filter(x => x.id !== key);
      const i = notes.findIndex(x => x.id === v.afterId);
      if (v.afterId !== null && i < 0) fail(400, 'Preceding note not found.');
      n.position = v.afterId === null ? (notes[0]?.position ?? 1)-1 : (notes[i].position + (notes[i+1]?.position ?? notes[i].position+2))/2;
    }
    const { afterId, ...fields } = v;
    Object.assign(n,fields,{updatedAt:now()}); this.pages.s.put('stickies',n); this.pages.events.emit(n.workspaceId,{type:'stickies'}); return n;
  }
  remove(a: Actor, key: string) { const n = this.sticky(a,key); this.pages.s.remove('stickies',key); this.pages.events.emit(n.workspaceId,{type:'stickies'}); return {ok:true}; }
}
export function registerDashboard(app: Hono<Env>, pages: Pages) {
  const d = new Dashboard(pages);
  app.get('/api/workspaces/:wid/home', c => c.json(d.home(c.get('actor'),c.req.param('wid'))));
  app.put('/api/workspaces/:wid/home', async c => { const scope = c.req.query('scope'); if (!['personal','workspace'].includes(scope ?? '')) fail(400,'Specify a home scope.'); return c.json(d.setHome(c.get('actor'),c.req.param('wid'),(await body(c,z.object({widgets:widgetsSchema}))).widgets,scope === 'personal')); });
  app.delete('/api/workspaces/:wid/home', c => { if(c.req.query('scope') !== 'personal') fail(400,'Only personal layouts can be reset.'); const a = c.get('actor'), wid = c.req.param('wid'); membership(pages.s,a,wid); if(a.access==='read')fail(403,'Read-only tokens cannot change layouts.'); pages.s.remove('layouts',wid+':'+a.user.id); pages.events.emit(wid,{type:'home'}); return c.json(d.home(a,wid)); });
  app.get('/api/workspaces/:wid/stickies', c => c.json(d.stickies(c.get('actor'),c.req.param('wid'))));
  app.post('/api/workspaces/:wid/stickies', async c => c.json(d.add(c.get('actor'),c.req.param('wid'),await body(c,stickyInput))));
  app.patch('/api/stickies/:id', async c => c.json(d.update(c.get('actor'),c.req.param('id'),await body(c,stickyInput))));
  app.delete('/api/stickies/:id', c => c.json(d.remove(c.get('actor'),c.req.param('id'))));
  app.get('/api/workspaces/:wid/stats', c => { const a=c.get('actor'),wid=c.req.param('wid'), ps=pages.list(a,wid).filter(p=>!pages.isTemplate(p)), visible=new Set(pages.list(a,wid,true).map(p=>p.id)), cutoff=new Date(Date.now()-7*86400000).toISOString(), acts=pages.s.all('activity').filter(x=>x.workspaceId===wid && x.at>cutoff && (!x.pageId || visible.has(x.pageId))); return c.json({ pages:ps.filter(x=>x.kind==='page').length, databases:ps.filter(x=>x.kind==='database').length, rows:ps.filter(x=>x.kind==='row').length, members:Number(pages.s.db.prepare('SELECT count(*) n FROM memberships WHERE workspaceId=?').get(wid)!.n), editsThisWeek:acts.length, aiEditsThisWeek:acts.filter(x=>x.actorType==='ai').length }); });
}

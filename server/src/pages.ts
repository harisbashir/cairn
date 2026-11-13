import type { Actor } from './common.ts';
import { fail, membership } from './common.ts';
import { Store, id, now } from './db.ts';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { backlinks, capture } from './collaboration.ts';
import type { Notifications } from './notifications.ts';
import { computeRows } from '../../shared/compute.ts';
import { rebuildLinks } from './links.ts';
import { validateSchema, validateProps, validateRepeat, normalizeReminders } from './page-fields.ts';
import { dateInZone, nextRepeatDate } from './repeat.ts';
import { templateList, templateInput, copyChildren, saveTemplate } from './templates.ts';
import { listComments, addComment } from './comments.ts';
import { listChanges, recordChange } from './changes.ts';
import { Events } from './events.ts';
import type { Activity, DocNode, Page, PageKind, PageVersion, Property, Row, SearchHit } from '../../shared/types.ts';
import { docToPlainText } from '../../shared/markdown.ts';
import type { PageCreate, PagePatch } from './page-validation.ts';
export { pageCreate, pagePatch, property } from './page-validation.ts';
export { registerPages } from './page-routes.ts';

export interface StoredPage extends Page {
  favoriteUsers?: string[];
  favoriteOrder?: Record<string, number>;
  shareToken?: string | null;
}
export interface StoredVersion extends PageVersion {
  pageId: string;
  content: DocNode | null;
  actorId: string;
}
interface StoredActivity extends Activity { workspaceId: string; actorId: string }
type PageChange = Activity['action'];

export class Pages {
  notifications?: Notifications;
  private lastChangeId?: string;
  constructor(public s: Store, public events: Events) {}

  isTemplate(page: Page): boolean { return page.isTemplate || this.ancestors(page).some(p=>p.isTemplate); }
  backlinks = (actor: Actor,pageId: string) => backlinks(this,actor,pageId);
  capture = (actor: Actor,input: {title?:string;text?:string;url?:string;workspaceId?:string;databaseId?:string}) => capture(this,actor,input);
  today(actor: Actor): string { return dateInZone(this.notifications?.clock()??new Date(),actor.user.prefs.timezone); }
  templates = (actor: Actor,wid: string,databaseId?: string) => templateList(this,actor,wid,databaseId);
  saveAsTemplate = (actor: Actor,pageId: string,title?: string) => saveTemplate(this,actor,pageId,title);
  comments = (actor: Actor,pageId: string) => listComments(this,actor,pageId);
  addComment = (actor: Actor,pageId: string,input: {body:string;quote?:string;threadId?:string}) => addComment(this,actor,pageId,input);
  changes = (actor: Actor,wid: string,options: {actor?:string;client?:string;before?:string;limit?:number}={}) => listChanges(this,actor,wid,options);

  ancestors(page: Page): Page[] {
    const result: Page[] = [];
    const seen = new Set([page.id]);
    let parentId = page.parentId;
    while (parentId) {
      const parent = this.s.get<Page>('pages', parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      result.unshift(parent);
      parentId = parent.parentId;
    }
    return result;
  }

  visible(page: Page, actor: Actor, includeTrash = false): boolean {
    return [...this.ancestors(page), page].every(ancestor =>
      (ancestor.visibility !== 'private' || ancestor.createdBy === actor.user.id) &&
      (includeTrash || !ancestor.deletedAt));
  }

  get(actor: Actor, pageId: string, write = false, includeTrash = false): StoredPage {
    const currentUser=this.s.get('users',actor.user.id);
    if(!currentUser||currentUser.disabled)fail(401,'Please sign in to continue.');
    const page = this.s.get<StoredPage>('pages', pageId);
    if (!page || (actor.workspaceId && actor.workspaceId !== page.workspaceId)) return fail(404, 'Page not found.');
    const member = this.s.db.prepare('SELECT role FROM memberships WHERE workspaceId=? AND userId=?')
      .get(page.workspaceId, actor.user.id);
    if (!member || !this.visible(page, actor, includeTrash)) fail(404, 'Page not found.');
    if (write) membership(this.s, actor, page.workspaceId, true);
    return page;
  }

  list(actor: Actor, workspaceId: string, includeTrash = false): StoredPage[] {
    membership(this.s, actor, workspaceId);
    return this.s.all<StoredPage>('pages').filter(page =>
      page.workspaceId === workspaceId && this.visible(page, actor, includeTrash));
  }

  path(page: Page): string { return this.ancestors(page).map(ancestor => ancestor.title).join(' / '); }

  row(page: Page): Row {
    return {
      id: page.id, title: page.title, icon: page.icon, props: page.props, position: page.position,
      cover: page.cover || firstImage(page.content), preview: docToPlainText(page.content).slice(0, 200),
      createdBy: page.createdBy, createdByName: this.s.get('users', page.createdBy)?.name ?? 'Former member', updatedByType: page.updatedByType ?? 'user',
      hasContent: !!page.content?.content?.length, createdAt: page.createdAt, updatedAt: page.updatedAt,
    };
  }

  rows(actor: Actor, pageId: string): Row[] {
    const database = this.get(actor, pageId);
    if (database.kind !== 'database') fail(400, 'This page is not a database.');
    return this.compute(actor,database,this.list(actor, database.workspaceId)
      .filter(page => page.parentId === pageId && page.kind === 'row' && !this.isTemplate(page))
      .sort((a, b) => a.position - b.position).map(page => this.row(page)));
  }

  position(actor: Actor, workspaceId: string, parentId: string | null, afterId?: string | null, exclude?: string): number {
    membership(this.s, actor, workspaceId);
    const siblings = this.s.all<Page>('pages').filter(page =>
      page.workspaceId === workspaceId && page.parentId === parentId && page.id !== exclude &&
      ![...this.ancestors(page), page].some(ancestor => ancestor.deletedAt))
      .sort((a, b) => a.position - b.position);
    let index = afterId === null ? -1 : siblings.length - 1;
    if (afterId !== null && afterId !== undefined) {
      const preceding = this.get(actor, afterId);
      if (preceding.parentId !== parentId || preceding.workspaceId !== workspaceId || preceding.id === exclude)
        fail(400, 'The preceding page must be a sibling.');
      index = siblings.findIndex(page => page.id === preceding.id);
      if (index < 0) fail(400, 'The preceding page must be a sibling.');
    }
    const between = () => {
      const left = siblings[index]?.position, right = siblings[index + 1]?.position;
      const value = left === undefined ? (right === undefined ? (afterId === null ? 0 : 1) : right - 1) : right === undefined ? left + 1 : left + (right - left) / 2;
      return Number.isFinite(value) && value > (left ?? -Infinity) && value < (right ?? Infinity) ? value : null;
    };
    const position = between();
    if (position !== null) return position;
    // Reclaim float precision before a midpoint collapses onto either neighbour.
    siblings.forEach((page, i) => { page.position = i + 1; this.s.put('pages', page); });
    return between()!;
  }

  index(page: Page): void { this.s.indexPage(page); }

  change(actor: Actor, page: Page, action: PageChange, merge = true, propertySchema?: Property[]): StoredPage {
    const before = this.s.get<Page>('pages',page.id);
    page.updatedAt = new Date(Math.max(Date.now(),Date.parse(before?.updatedAt ?? '')+1 || 0)).toISOString();
    page.updatedBy = actor.user.id;
    page.updatedByType = actor.actorType;
    this.s.put('pages', page);
    this.index(page);
    rebuildLinks(this.s,page,actor.requestOrigin);
    const activity: StoredActivity = {
      id: id(), workspaceId: page.workspaceId, actorId: actor.user.id, at: page.updatedAt,
      actorName: actor.user.name, actorType: actor.actorType, action, clientName: actor.clientName ?? null,
      pageId: page.id, pageTitle: page.title, pageIcon: page.icon,
    };
    this.s.put('activity',activity);
    this.lastChangeId=recordChange(this,actor,page,before,activity,merge,propertySchema);
    void this.notifications?.pageChanged(actor,page,before).catch(()=>{});
    this.events.emit(page.workspaceId, {
      type: 'page', pageId: page.id, parentId: page.parentId,
      change: ['shared','repeated','undone','joined'].includes(action) ? 'updated' : action as 'created'|'updated'|'deleted'|'restored'|'moved',
      actorId: actor.user.id, actorType: actor.actorType, clientId: actor.clientId,
    });
    return page;
  }

  compute<T extends {id:string;title:string;props:Page['props']}>(actor:Actor,database:Page,rows:T[]):T[] {
    const visible=this.list(actor,database.workspaceId).filter(p=>!this.isTemplate(p));
    return computeRows(rows,database.schema,{
      getRows:databaseId=>visible.filter(p=>p.kind==='row'&&p.parentId===databaseId),
      getSchema:databaseId=>visible.find(p=>p.id===databaseId&&p.kind==='database')?.schema??[],
      getPersonName:userId=>this.s.get('users',userId)?.name??'', userId:actor.user.id,today:this.today(actor),
    });
  }
  computed(actor:Actor,page:Page):Page {
    if(page.kind!=='row'||!page.parentId)return page;
    const database=this.get(actor,page.parentId);
    return {...this.compute(actor,database,[{...page,isTemplate:false}])[0],isTemplate:page.isTemplate};
  }

  validateFields(kind: PageKind, input: PagePatch): void {
    if (kind !== 'row' && input.repeat) fail(400,'Only rows can repeat.');
    if (kind !== 'database' && input.defaultTemplateId !== undefined) fail(400,'Only databases have default templates.');
    if (kind !== 'row' && input.props !== undefined) fail(400, 'Only rows have properties.');
    if (kind !== 'database' && (input.schema !== undefined || input.views !== undefined))
      fail(400, 'Only databases have schemas and views.');
  }

  create(actor: Actor, workspaceId: string, input: PageCreate): StoredPage {
    membership(this.s, actor, workspaceId, true);
    const applied=templateInput(this,actor,workspaceId,input,this.today(actor));
    input=applied.input;
    const parentId = input.isTemplate && (input.kind??'page')==='page' ? null : input.parentId ?? null;
    const parent = parentId ? this.get(actor, parentId, true) : null;
    if (parent && parent.workspaceId !== workspaceId) fail(400, 'Parent belongs to another workspace.');
    const kind = input.kind ?? 'page';
    this.validateFields(kind, input);
    if (kind === 'row' && parent?.kind !== 'database') fail(400, 'Rows require a database parent.');
    let schema = input.schema ?? [];
    let views = input.views ?? [];
    if (kind === 'database') {
      if (!schema.length) schema = [{
        id: id(), name: 'Status', type: 'status',
        options: ['Not started', 'In progress', 'Done'].map((name, index) => ({
          id: id(), name, color: (['gray', 'blue', 'green'] as const)[index],
        })),
      }];
      if (!views.length) views = [{ id: id(), name: 'Table', type: 'table', filters: [], sorts: [] }];
    }
    if(kind==='database')validateSchema(this,actor,workspaceId,schema);
    if(kind==='row')validateProps(this,actor,parent,input.props??{});
    validateRepeat(parent?.schema??[],input.repeat??null,kind);
    const at = now();
    const page: Page = {
      id: id(), workspaceId, parentId, kind, title: input.title ?? '', icon: input.icon ?? '',
      cover: input.cover ?? '', visibility: input.visibility ?? 'workspace', content: input.content ?? null,
      props: kind === 'row' ? input.props ?? {} : {}, schema: kind === 'database' ? schema : [],
      views: kind === 'database' ? views : [], position: this.position(actor, workspaceId, parentId, input.afterId),
      createdBy: actor.user.id, updatedBy: actor.user.id, updatedByType: actor.actorType,
      createdAt: at, updatedAt: at, deletedAt: null,
      repeat:input.repeat??null,reminders:[],isTemplate:input.isTemplate??false,defaultTemplateId:null,
    };
    if(input.reminders)page.reminders=normalizeReminders(this,actor,page,input.reminders);
    const result=this.change(actor, page, 'created');
    if(applied.template?.kind==='page')copyChildren(this,actor,applied.template,page);
    return result;
  }

  snapshot(actor: Actor, page: Page, force = false): void {
    const versions = this.s.all<StoredVersion>('versions').reverse().filter(version => version.pageId === page.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = versions[0];
    if (force || !latest || latest.actorId !== actor.user.id || latest.createdByType !== actor.actorType ||
        Date.now() - Date.parse(latest.createdAt) > 600000) {
      this.s.put('versions', {
        id: id(), pageId: page.id, title: page.title, content: page.content, createdAt: now(),
        actorId: actor.user.id, createdByName: actor.user.name, createdByType: actor.actorType,
      });
      for (const version of versions.slice(49)) this.s.remove('versions', version.id);
    }
  }

  patch(actor: Actor, pageId: string, input: PagePatch): StoredPage {
    const page = this.get(actor, pageId, true);
    const previousSchema = page.schema;
    const parent=page.parentId?this.get(actor,page.parentId):null;
    if(input.schema)validateSchema(this,actor,page.workspaceId,input.schema,page.id);
    if(input.props)validateProps(this,actor,parent,input.props);
    if(input.repeat!==undefined)validateRepeat(parent?.schema??[],input.repeat,page.kind);
    if(input.defaultTemplateId){const template=this.get(actor,input.defaultTemplateId);if(!template.isTemplate||template.kind!=='row'||template.parentId!==page.id)fail(400,'Default template must be a template row in this database.');}
    const oldDone=page.repeat?page.props[page.repeat.doneProp]:undefined;
    const oldDate=page.repeat?page.props[page.repeat.dateProp]:undefined;
    if(input.reminders)input={...input,reminders:normalizeReminders(this,actor,page,input.reminders)};
    this.validateFields(page.kind, input);
    if (input.title !== undefined || input.content !== undefined) this.snapshot(actor, page);
    if (input.props) {
      for (const [key, value] of Object.entries(input.props)) {
        if (value === null) delete page.props[key];
        else page.props[key] = value;
      }
    }
    const { props, ...rest } = input;
    Object.assign(page, rest);
    if(page.isTemplate&&page.kind==='page')page.parentId=null;
    let action:PageChange='updated';
    if(page.repeat&&input.props&&Object.hasOwn(input.props,page.repeat.doneProp)&&oldDone!==page.repeat.doneValue&&page.props[page.repeat.doneProp]===page.repeat.doneValue){
      const next=nextRepeatDate(page.repeat,typeof oldDate==='string'?oldDate:this.today(actor),this.today(actor));
      action='repeated';
      page.reminders=page.reminders.map(r=>({...r,lastFiredFor:null}));
      if(next){page.props[page.repeat.dateProp]=next;page.props[page.repeat.doneProp]=page.repeat.resetValue;}else page.repeat=null;
    }
    const save = () => {
      if(input.isTemplate===false)this.clearDefault(actor,page);
      const result = this.change(actor, page, action);
      const parentChangeId=this.lastChangeId;
      if (page.kind === 'database' && input.schema !== undefined) {
        for (const row of this.s.all<Page>('pages').filter(row => row.parentId === page.id && row.kind === 'row')) {
          const oldProps=JSON.stringify(row.props);
          for (const oldProperty of previousSchema) {
            const property = page.schema.find(property => property.id === oldProperty.id);
            if (!property) { delete row.props[oldProperty.id]; continue; }
            if (!['select', 'status', 'multi_select'].includes(property.type)) continue;
            const removed = new Set(oldProperty.options?.filter(option => !property.options?.some(next => next.id === option.id)).map(option => option.id));
            const value = row.props[property.id];
            if (Array.isArray(value)) row.props[property.id] = value.filter(option => !removed.has(option));
            else if (typeof value === 'string' && removed.has(value)) delete row.props[property.id];
          }
          if(JSON.stringify(row.props)!==oldProps){
            this.change(actor,row,'updated',false,previousSchema);
            if(parentChangeId&&this.lastChangeId){const parentChange=this.s.get('changes',parentChangeId);parentChange.relatedIds=[...(parentChange.relatedIds??[]),this.lastChangeId];this.s.put('changes',parentChange);}
          }else{this.index(row);rebuildLinks(this.s,row,actor.requestOrigin);}
        }
      }
      return result;
    };
    return this.s.transaction(save);
  }

  clearDefault(actor:Actor,page:Page):void {
    const database=page.parentId?this.s.get<Page>('pages',page.parentId):undefined;
    if(database?.defaultTemplateId===page.id){database.defaultTemplateId=null;this.change(actor,database,'updated');}
  }

  move(actor: Actor, pageId: string, parentId: string | null, afterId?: string | null): StoredPage {
    const page = this.get(actor, pageId, true);
    const parent = parentId ? this.get(actor, parentId, true) : null;
    if (parent && (parent.workspaceId !== page.workspaceId || parent.id === page.id ||
        this.ancestors(parent).some(ancestor => ancestor.id === page.id)))
      fail(400, 'A page cannot be moved into itself, its descendants, or another workspace.');
    if (page.kind === 'row' && parent?.kind !== 'database') fail(400, 'Rows must stay in a database.');
    if(page.isTemplate&&page.kind==='page'&&parentId!==null)fail(400,'Page templates must stay at the root.');
    return this.s.transaction(()=>{
      const position=this.position(actor,page.workspaceId,parentId,afterId,page.id);
      if(page.parentId!==parentId)this.clearDefault(actor,page);
      page.position=position;page.parentId=parentId;
      return this.change(actor,page,'moved');
    });
  }

  duplicate(actor: Actor, pageId: string): StoredPage {
    const original = this.get(actor, pageId, true);
    const input = (page: Page): PageCreate => ({
      parentId: page.parentId, kind: page.kind, title: page.title, icon: page.icon,
      cover: page.cover, visibility: page.visibility, content: page.content,
      ...(page.kind === 'row' ? { props: page.props } : {}),
      ...(page.kind === 'database' ? { schema: page.schema, views: page.views } : {}),
    });
    const copy = this.create(actor, original.workspaceId, { ...input(original), title: original.title + ' copy', afterId: original.id });
    const recurse = (source: Page, target: Page): void => {
      const children = this.list(actor, source.workspaceId).filter(page => page.parentId === source.id)
        .sort((a, b) => a.position - b.position);
      for (const child of children) {
        const next = this.create(actor, source.workspaceId, { ...input(child), parentId: target.id });
        recurse(child, next);
      }
    };
    recurse(original, copy);
    return copy;
  }

  remove(actor: Actor, pageId: string, permanent = false): void {
    const page = this.get(actor, pageId, true, true);
    if (!permanent) {
      if(page.parentId){const database=this.s.get<Page>('pages',page.parentId);if(database?.defaultTemplateId===page.id){database.defaultTemplateId=null;this.change(actor,database,'updated');}}
      page.deletedAt = now();
      this.change(actor, page, 'deleted');
      return;
    }
    if (![...this.ancestors(page), page].some(ancestor => ancestor.deletedAt))
      fail(400, 'Move the page to trash before deleting permanently.');
    this.change(actor, page, 'deleted');
    const descendants = this.s.all<Page>('pages').filter(candidate => this.ancestors(candidate).some(ancestor => ancestor.id === page.id));
    for (const removed of [page, ...descendants]) {
      this.s.remove('pages', removed.id);
      this.s.db.prepare('DELETE FROM links WHERE fromId=? OR toId=?').run(removed.id,removed.id);
      for(const c of this.s.all('comments').filter(c=>c.pageId===removed.id))this.s.remove('comments',c.id);
      this.s.db.prepare('DELETE FROM search WHERE id=?').run(removed.id);
      for (const version of this.s.all<StoredVersion>('versions').filter(version => version.pageId === removed.id))
        this.s.remove('versions', version.id);
    }
  }

  restore(actor: Actor, pageId: string): StoredPage {
    const page = this.get(actor, pageId, true, true);
    if (page.parentId) {
      const parent = this.s.get<Page>('pages', page.parentId);
      if (!parent || [...this.ancestors(parent), parent].some(ancestor => ancestor.deletedAt)) page.parentId = null;
    }
    page.deletedAt = null;
    return this.change(actor, page, 'restored');
  }

  search(actor: Actor, workspaceId: string, queryText: string, limit = 30): SearchHit[] {
    const pages = new Map(this.list(actor, workspaceId).filter(p=>!this.isTemplate(p)).map(page => [page.id, page]));
    const terms = queryText.match(/[\p{L}\p{N}_]+/gu);
    if (!terms?.length) return [];
    const query = terms.map((term, index) => '"' + term + '"' + (index === terms.length - 1 ? '*' : '')).join(' AND ');
    const hits = this.s.db.prepare("SELECT id, snippet(search,2,char(1),char(2),'…',30) AS snippet FROM search WHERE search MATCH ? ORDER BY bm25(search,0,8,1)").all(query);
    return hits.flatMap(hit => {
      const page = pages.get(String(hit.id));
      return page ? [{
        id: page.id, kind: page.kind, title: page.title, icon: page.icon, snippet: String(hit.snippet).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'),
        path: this.path(page), updatedAt: page.updatedAt,
      }] : [];
    }).slice(0, Math.max(0, Math.min(limit, 200)));
  }

  activity(actor: Actor, workspaceId: string, limit = 50, before?: string): Activity[] {
    const visible = new Set(this.list(actor, workspaceId, true).map(page => page.id));
    return this.s.all<StoredActivity>('activity').reverse().filter(activity =>
      activity.workspaceId === workspaceId && (!activity.pageId || visible.has(activity.pageId)) && (!before || activity.at < before))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.min(200, limit))
      .map(({ workspaceId, actorId, ...activity }) => activity);
  }

  deleteWorkspace(workspaceId: string): void {
    const ids=new Set(this.s.all<Page>('pages').filter(p=>p.workspaceId===workspaceId).map(p=>p.id));
    for(const c of this.s.all('comments').filter(c=>ids.has(c.pageId)))this.s.remove('comments',c.id);
    for(const key of ids)this.s.db.prepare('DELETE FROM links WHERE fromId=? OR toId=?').run(key,key);
    for (const page of this.s.all<Page>('pages').filter(page => page.workspaceId === workspaceId)) {
      this.s.remove('pages', page.id);
      this.s.db.prepare('DELETE FROM search WHERE id=?').run(page.id);
      for (const version of this.s.all<StoredVersion>('versions').reverse().filter(version => version.pageId === page.id))
        this.s.remove('versions', version.id);
    }
    for (const table of ['invites', 'activity', 'files', 'tokens', 'layouts', 'stickies', 'calendars', 'feeds', 'oauthGrants','comments','changes','notifications'] as const) {
      for (const value of this.s.all<{ id: string; workspaceId: string }>(table).filter(value => value.workspaceId === workspaceId)) {
        if (table === 'files') {
          try { unlinkSync(join(this.s.dataDir, 'files', value.id)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        this.s.remove(table, value.id);
      }
    }
    this.s.remove('workspaces', workspaceId);
  }
}

export function clean(page: Page): Page {
  const { favoriteUsers, favoriteOrder, shareToken, ...result } = page as StoredPage;
  return result;
}

export function publicPage(pages: Pages, token: string): StoredPage {
  const page = pages.s.all<StoredPage>('pages').find(page => page.shareToken === token);
  if (!page || [...pages.ancestors(page), page].some(ancestor => ancestor.deletedAt)) return fail(404, 'Shared page not found.');
  return page;
}

function firstImage(node: DocNode | null): string { if (!node) return ''; if (node.type === 'image') return String(node.attrs?.src ?? ''); for (const child of node.content ?? []) { const src = firstImage(child); if (src) return src; } return ''; }

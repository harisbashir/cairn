import type { Actor } from './common.ts';
import { fail, membership } from './common.ts';
import { Store, id, now } from './db.ts';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Events } from './events.ts';
import type { Activity, DocNode, Page, PageKind, PageVersion, Row, SearchHit } from '../../shared/types.ts';
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
type PageChange = 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'shared';

export class Pages {
  constructor(public s: Store, public events: Events) {}

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
    return this.list(actor, database.workspaceId)
      .filter(page => page.parentId === pageId && page.kind === 'row')
      .sort((a, b) => a.position - b.position).map(page => this.row(page));
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

  change(actor: Actor, page: Page, action: PageChange): StoredPage {
    page.updatedAt = now();
    page.updatedBy = actor.user.id;
    page.updatedByType = actor.actorType;
    this.s.put('pages', page);
    this.index(page);
    this.s.put('activity', {
      id: id(), workspaceId: page.workspaceId, actorId: actor.user.id, at: now(),
      actorName: actor.user.name, actorType: actor.actorType, action,
      pageId: page.id, pageTitle: page.title, pageIcon: page.icon,
    });
    this.events.emit(page.workspaceId, {
      type: 'page', pageId: page.id, parentId: page.parentId,
      change: action === 'shared' ? 'updated' : action,
      actorId: actor.user.id, actorType: actor.actorType, clientId: actor.clientId,
    });
    return page;
  }

  validateFields(kind: PageKind, input: PagePatch): void {
    if (kind !== 'row' && input.props !== undefined) fail(400, 'Only rows have properties.');
    if (kind !== 'database' && (input.schema !== undefined || input.views !== undefined))
      fail(400, 'Only databases have schemas and views.');
  }

  create(actor: Actor, workspaceId: string, input: PageCreate): StoredPage {
    membership(this.s, actor, workspaceId, true);
    const parentId = input.parentId ?? null;
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
    const at = now();
    const page: Page = {
      id: id(), workspaceId, parentId, kind, title: input.title ?? '', icon: input.icon ?? '',
      cover: input.cover ?? '', visibility: input.visibility ?? 'workspace', content: input.content ?? null,
      props: kind === 'row' ? input.props ?? {} : {}, schema: kind === 'database' ? schema : [],
      views: kind === 'database' ? views : [], position: this.position(actor, workspaceId, parentId, input.afterId),
      createdBy: actor.user.id, updatedBy: actor.user.id, updatedByType: actor.actorType,
      createdAt: at, updatedAt: at, deletedAt: null,
    };
    return this.change(actor, page, 'created');
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
    const save = () => {
      const result = this.change(actor, page, 'updated');
      if (page.kind === 'database' && input.schema !== undefined) {
        for (const row of this.s.all<Page>('pages').filter(row => row.parentId === page.id && row.kind === 'row')) {
          for (const oldProperty of previousSchema) {
            const property = page.schema.find(property => property.id === oldProperty.id);
            if (!property) { delete row.props[oldProperty.id]; continue; }
            if (!['select', 'status', 'multi_select'].includes(property.type)) continue;
            const removed = new Set(oldProperty.options?.filter(option => !property.options?.some(next => next.id === option.id)).map(option => option.id));
            const value = row.props[property.id];
            if (Array.isArray(value)) row.props[property.id] = value.filter(option => !removed.has(option));
            else if (typeof value === 'string' && removed.has(value)) delete row.props[property.id];
          }
          this.s.put('pages', row);
          this.index(row);
        }
      }
      return result;
    };
    return input.schema !== undefined ? this.s.transaction(save) : save();
  }

  move(actor: Actor, pageId: string, parentId: string | null, afterId?: string | null): StoredPage {
    const page = this.get(actor, pageId, true);
    const parent = parentId ? this.get(actor, parentId, true) : null;
    if (parent && (parent.workspaceId !== page.workspaceId || parent.id === page.id ||
        this.ancestors(parent).some(ancestor => ancestor.id === page.id)))
      fail(400, 'A page cannot be moved into itself, its descendants, or another workspace.');
    if (page.kind === 'row' && parent?.kind !== 'database') fail(400, 'Rows must stay in a database.');
    page.position = this.position(actor, page.workspaceId, parentId, afterId, page.id);
    page.parentId = parentId;
    return this.change(actor, page, 'moved');
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
    const pages = new Map(this.list(actor, workspaceId).map(page => [page.id, page]));
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
    for (const page of this.s.all<Page>('pages').filter(page => page.workspaceId === workspaceId)) {
      this.s.remove('pages', page.id);
      this.s.db.prepare('DELETE FROM search WHERE id=?').run(page.id);
      for (const version of this.s.all<StoredVersion>('versions').reverse().filter(version => version.pageId === page.id))
        this.s.remove('versions', version.id);
    }
    for (const table of ['invites', 'activity', 'files', 'tokens', 'layouts', 'stickies', 'calendars', 'feeds', 'oauthGrants'] as const) {
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

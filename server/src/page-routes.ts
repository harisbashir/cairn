import { publicComputed, publicRows } from './public-pages.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Page, User } from '../../shared/types.ts';
import { body, fail, membership, publicUrl, type Env } from './common.ts';
import { id } from './db.ts';
import { clean, publicPage, type Pages, type StoredVersion, type StoredPage } from './pages.ts';
import { pageCreate, pagePatch } from './page-validation.ts';

function limit(value: string | undefined, fallback = 50): number {
  return Math.max(0, Math.min(200, Number(value) || fallback));
}

export function registerPages(app: Hono<Env>, pages: Pages): void {
  app.get('/api/workspaces/:wid/tree', c => {
    const actor = c.get('actor');
    const visible = pages.list(actor, c.req.param('wid')).filter(page => page.kind !== 'row' && !pages.isTemplate(page));
    const favorites = visible.filter(page => page.favoriteUsers?.includes(actor.user.id))
      .sort((a, b) => (a.favoriteOrder?.[actor.user.id] ?? 0) - (b.favoriteOrder?.[actor.user.id] ?? 0));
    return c.json({
      nodes: visible.map(page => ({
        id: page.id, parentId: page.parentId, kind: page.kind, title: page.title, icon: page.icon,
        position: page.position, visibility: page.visibility, createdBy: page.createdBy,
      })),
      favorites: favorites.map(page => page.id),
    });
  });

  app.post('/api/workspaces/:wid/pages', async c => {
    const input = await body(c, pageCreate);
    return c.json(clean(pages.create(c.get('actor'), c.req.param('wid'), input)));
  });

  app.get('/api/pages/:id', c => {
    const actor = c.get('actor');
    const page = pages.get(actor, c.req.param('id'));
    const member = membership(pages.s, actor, page.workspaceId);
    return c.json({
      ...clean(pages.computed(actor,page)),
      commentCount:pages.comments(actor,page.id).filter(c=>c.threadId===c.id&&!c.resolved).length,
      breadcrumbs: pages.ancestors(page).map(ancestor => ({
        id: ancestor.id, title: ancestor.title, icon: ancestor.icon, kind: ancestor.kind,
      })),
      favorite: page.favoriteUsers?.includes(actor.user.id) ?? false,
      shareToken: page.shareToken ?? null,
      canEdit: member.role !== 'viewer' && actor.access !== 'read',
      ...(page.kind === 'row' ? { parentSchema: pages.s.get<Page>('pages', page.parentId!)?.schema ?? [] } : {}),
    });
  });

  app.patch('/api/pages/:id', async c => {
    const input = await body(c, pagePatch);
    return c.json(clean(pages.patch(c.get('actor'), c.req.param('id'), input)));
  });

  app.post('/api/pages/:id/move', async c => {
    const input = await body(c, z.object({ parentId: z.string().nullable(), afterId: z.string().nullable().optional() }));
    return c.json(clean(pages.move(c.get('actor'), c.req.param('id'), input.parentId, input.afterId)));
  });

  app.post('/api/pages/:id/duplicate', c => c.json(clean(pages.duplicate(c.get('actor'), c.req.param('id')))));
  app.delete('/api/pages/:id', c => {
    pages.remove(c.get('actor'), c.req.param('id'), c.req.query('permanent') === '1');
    return c.json({ ok: true });
  });
  app.post('/api/pages/:id/restore', c => c.json(clean(pages.restore(c.get('actor'), c.req.param('id')))));
  app.get('/api/pages/:id/rows', c => c.json(pages.rows(c.get('actor'), c.req.param('id'))));

  for (const method of ['put', 'delete'] as const) {
    app[method]('/api/pages/:id/favorite', c => {
      const actor = c.get('actor');
      const page = pages.get(actor, c.req.param('id'), true);
      const favorites = new Set(page.favoriteUsers ?? []);
      page.favoriteOrder ??= {};
      if (method === 'put') {
        if (!favorites.has(actor.user.id)) {
          const maximum = Math.max(0, ...pages.s.all<StoredPage>('pages')
            .filter(candidate => candidate.workspaceId === page.workspaceId)
            .map(candidate => candidate.favoriteOrder?.[actor.user.id] ?? 0));
          page.favoriteOrder[actor.user.id] = maximum + 1;
        }
        favorites.add(actor.user.id);
      } else {
        favorites.delete(actor.user.id);
        delete page.favoriteOrder[actor.user.id];
      }
      page.favoriteUsers = [...favorites];
      pages.change(actor, page, 'updated');
      return c.json({ ok: true });
    });
  }

  app.get('/api/pages/:id/versions', c => {
    const page = pages.get(c.get('actor'), c.req.param('id'));
    return c.json(pages.s.all<StoredVersion>('versions').reverse().filter(version => version.pageId === page.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, title, createdAt, createdByName, createdByType }) => ({ id, title, createdAt, createdByName, createdByType })));
  });

  app.post('/api/pages/:id/versions/:versionId/restore', c => {
    const actor = c.get('actor');
    const page = pages.get(actor, c.req.param('id'), true);
    const version = pages.s.get<StoredVersion>('versions', c.req.param('versionId'));
    if (!version || version.pageId !== page.id) return fail(404, 'Version not found.');
    pages.snapshot(actor, page, true);
    page.title = version.title;
    page.content = version.content;
    return c.json(clean(pages.change(actor, page, 'updated')));
  });

  app.post('/api/pages/:id/share', c => {
    const actor = c.get('actor');
    const page = pages.get(actor, c.req.param('id'), true);
    page.shareToken ??= id();
    pages.change(actor, page, 'shared');
    c.header('Link', `<${publicUrl(c, '/s/' + page.shareToken)}>; rel="canonical"`);
    return c.json({ token: page.shareToken });
  });
  app.delete('/api/pages/:id/share', c => {
    const actor = c.get('actor');
    const page = pages.get(actor, c.req.param('id'), true);
    delete page.shareToken;
    pages.change(actor, page, 'shared');
    return c.json({ ok: true });
  });

  app.get('/api/public/:token', c => {
    const page = publicPage(pages, c.req.param('token'));
    c.header('Link', `<${publicUrl(c, '/s/' + c.req.param('token'))}>; rel="canonical"`);
    const rows = page.kind === 'database' ? publicRows(pages,page) : [];
    return c.json({ page: clean(publicComputed(pages,page)), rows });
  });

  app.get('/api/workspaces/:wid/trash', c => {
    const trash = pages.list(c.get('actor'), c.req.param('wid'), true)
      .filter(page => page.deletedAt && !pages.ancestors(page).some(ancestor => ancestor.deletedAt));
    return c.json(trash.map(page => ({
      id: page.id, kind: page.kind, title: page.title, icon: page.icon, deletedAt: page.deletedAt!,
      deletedByName: pages.s.get<User>('users', page.updatedBy)?.name ?? 'Deleted user',
    })));
  });
  app.get('/api/workspaces/:wid/search', c => c.json(pages.search(
    c.get('actor'), c.req.param('wid'), c.req.query('q') ?? '', limit(c.req.query('limit'), 30))));
  app.get('/api/workspaces/:wid/recent', c => {
    const recent = pages.list(c.get('actor'), c.req.param('wid')).filter(p=>!pages.isTemplate(p))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit(c.req.query('limit')));
    return c.json(recent.map(page => ({
      id: page.id, kind: page.kind, title: page.title, icon: page.icon, path: pages.path(page),
      updatedAt: page.updatedAt, updatedByName: pages.s.get<User>('users', page.updatedBy)?.name ?? 'Deleted user',
      updatedByType: page.updatedByType,
    })));
  });
  app.get('/api/workspaces/:wid/activity', c => c.json(pages.activity(
    c.get('actor'), c.req.param('wid'), limit(c.req.query('limit')), c.req.query('before'))));
}

import type { Comment, Page } from '../../shared/types.ts';
import type { Actor } from './common.ts';
import { fail, membership } from './common.ts';
import type { Pages } from './pages.ts';
import { id, now } from './db.ts';

export function listComments(pages: Pages, actor: Actor, pageId: string): Comment[] {
  pages.get(actor, pageId);
  const all = pages.s
    .all<Comment>('comments')
    .filter((c) => c.pageId === pageId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all.map((c) => ({ ...c, resolved: all.find((root) => root.id === c.threadId)?.resolved ?? c.resolved }));
}
export function addComment(
  pages: Pages,
  actor: Actor,
  pageId: string,
  input: { body: string; quote?: string; threadId?: string },
): Comment {
  const page = pages.get(actor, pageId);
  if (actor.access === 'read') fail(403, 'Read-only tokens cannot comment.');
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 5000)
    fail(400, 'Comment body must contain 1 to 5000 characters.');
  const thread = input.threadId ? pages.s.get<Comment>('comments', input.threadId) : undefined;
  if (input.threadId && (!thread || thread.pageId !== pageId || thread.id !== thread.threadId))
    fail(400, 'Thread not found on this page.');
  const key = id(),
    at = now();
  const comment: Comment = {
    id: key,
    pageId,
    threadId: thread?.id ?? key,
    quote: thread?.quote ?? input.quote ?? '',
    body: input.body,
    resolved: thread?.resolved ?? false,
    createdBy: actor.user.id,
    createdByName: actor.user.name,
    createdByType: actor.actorType,
    createdAt: at,
    updatedAt: at,
  };
  const previous = pages.s
    .all<Comment>('comments')
    .filter((c) => c.pageId === pageId && c.threadId === comment.threadId);
  pages.s.put('comments', comment);
  pages.events.emit(page.workspaceId, { type: 'comments', pageId });
  pages.notifications?.commentAdded(actor, page, comment, previous);
  return comment;
}
export function updateComment(
  pages: Pages,
  actor: Actor,
  key: string,
  input: { body?: string; resolved?: boolean },
): Comment {
  const c = pages.s.get<Comment>('comments', key) ?? fail(404, 'Comment not found.');
  const page = pages.get(actor, c.pageId);
  const oldBody = c.body;
  if (actor.access === 'read') fail(403, 'Read-only tokens cannot change comments.');
  if (input.body !== undefined) {
    if (c.createdBy !== actor.user.id) fail(403, 'Only the author can edit a comment.');
    if (!input.body.trim() || input.body.length > 5000) fail(400, 'Invalid comment body.');
    c.body = input.body;
  }
  if (input.resolved !== undefined) {
    membership(pages.s, actor, page.workspaceId, true);
    for (const reply of pages.s.all<Comment>('comments').filter((r) => r.threadId === c.threadId)) {
      reply.resolved = input.resolved;
      reply.updatedAt = now();
      pages.s.put('comments', reply);
    }
    c.resolved = input.resolved;
  }
  c.updatedAt = now();
  pages.s.put('comments', c);
  if (input.body !== undefined) void pages.notifications?.commentChanged(actor, page, c.body, oldBody);
  pages.events.emit(page.workspaceId, { type: 'comments', pageId: page.id });
  return c;
}
export function deleteComment(pages: Pages, actor: Actor, key: string): void {
  const c = pages.s.get<Comment>('comments', key) ?? fail(404, 'Comment not found.');
  const page = pages.get(actor, c.pageId),
    m = membership(pages.s, actor, page.workspaceId);
  if (actor.access === 'read' || (c.createdBy !== actor.user.id && !['owner', 'admin'].includes(m.role)))
    fail(403, 'Only the author or an administrator can delete comments.');
  for (const item of pages.s
    .all<Comment>('comments')
    .filter((r) => r.id === c.id || (c.id === c.threadId && r.threadId === c.id)))
    pages.s.remove('comments', item.id);
  pages.events.emit(page.workspaceId, { type: 'comments', pageId: page.id });
}

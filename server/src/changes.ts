import type { Activity, ChangeDetail, ChangeSummary, Page, Property, PropValue } from '../../shared/types.ts';
import type { Actor } from './common.ts';
import { fail, membership } from './common.ts';
import type { Pages } from './pages.ts';
import { docToMarkdown } from '../../shared/markdown.ts';
import { now } from './db.ts';

interface Delta {
  before: unknown;
  after: unknown;
}
export interface StoredChange {
  id: string;
  workspaceId: string;
  pageId: string;
  actorId: string;
  clientId: string | null;
  actorType: Actor['actorType'];
  clientName: string | null;
  at: string;
  action: Activity['action'];
  values: Record<string, Delta>;
  pageUpdatedAt: string;
  beforeUpdatedAt?: string;
  relatedIds?: string[];
  propertySchema?: Property[];
  mergeable?: boolean;
  undoneAt: string | null;
  undoneByName: string | null;
}
const fields = [
  'title',
  'icon',
  'cover',
  'content',
  'schema',
  'views',
  'parentId',
  'position',
  'visibility',
  'deletedAt',
  'repeat',
  'reminders',
  'isTemplate',
  'defaultTemplateId',
] as const;
const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function recordChange(
  pages: Pages,
  actor: Actor,
  page: Page,
  before: Page | undefined,
  activity: Activity,
  merge = true,
  propertySchema?: Property[],
): string | undefined {
  const values: Record<string, Delta> = {};
  for (const key of fields)
    if (!equal(before?.[key], page[key])) values[key] = { before: before?.[key] ?? null, after: page[key] ?? null };
  for (const key of new Set([...Object.keys(before?.props ?? {}), ...Object.keys(page.props)]))
    if (!equal(before?.props[key], page.props[key]))
      values['props.' + key] = { before: before?.props[key] ?? null, after: page.props[key] ?? null };
  if (!Object.keys(values).length && activity.action !== 'created') return;
  const previous = pages.s
    .all<StoredChange>('changes')
    .filter((c) => c.pageId === page.id)
    .at(-1);
  if (
    merge &&
    activity.action === 'updated' &&
    previous?.action === 'updated' &&
    previous.mergeable !== false &&
    !previous.undoneAt &&
    previous.actorId === actor.user.id &&
    previous.actorType === actor.actorType &&
    previous.clientName === (actor.clientName ?? null) &&
    previous.clientId === actor.clientId &&
    Date.parse(activity.at) - Date.parse(previous.at) <= 120000
  ) {
    for (const [key, value] of Object.entries(values))
      previous.values[key] = previous.values[key] ? { before: previous.values[key].before, after: value.after } : value;
    previous.at = activity.at;
    previous.pageUpdatedAt = page.updatedAt;
    pages.s.put('changes', previous);
    const old = pages.s.get('activity', previous.id);
    if (old) pages.s.put('activity', { ...old, at: activity.at, pageTitle: page.title, pageIcon: page.icon });
    pages.s.remove('activity', activity.id);
    return previous.id;
  }
  pages.s.put('changes', {
    id: activity.id,
    mergeable: merge,
    propertySchema:
      page.kind === 'row' ? (propertySchema ?? pages.s.get<Page>('pages', page.parentId ?? '')?.schema) : undefined,
    workspaceId: page.workspaceId,
    pageId: page.id,
    actorId: actor.user.id,
    clientId: actor.clientId,
    actorType: actor.actorType,
    clientName: actor.clientName ?? null,
    at: activity.at,
    action: activity.action,
    values,
    pageUpdatedAt: page.updatedAt,
    beforeUpdatedAt: before?.updatedAt,
    undoneAt: null,
    undoneByName: null,
  });
  return activity.id;
}
function label(pages: Pages, page: Page, key: string, schema?: Property[]): string {
  if (key.startsWith('props.'))
    return (
      (schema ?? pages.s.get<Page>('pages', page.parentId ?? '')?.schema)?.find((p) => p.id === key.slice(6))?.name ??
      'Properties'
    );
  return (
    (
      {
        title: 'Title',
        icon: 'Icon',
        cover: 'Cover',
        content: 'Content',
        schema: 'Properties',
        views: 'Views',
        parentId: 'Location',
        position: 'Location',
        visibility: 'Visibility',
        deletedAt: 'Trash',
        repeat: 'Repeat',
        reminders: 'Reminders',
        isTemplate: 'Template',
        defaultTemplateId: 'Default template',
      } as Record<string, string>
    )[key] ?? key
  );
}
export function summary(pages: Pages, actor: Actor, c: StoredChange): ChangeSummary {
  const page = pages.get(actor, c.pageId, false, true),
    activity = pages.s.get<Activity>('activity', c.id)!;
  const m = membership(pages.s, actor, page.workspaceId);
  return {
    id: c.id,
    at: c.at,
    actorName: activity?.actorName ?? 'Former member',
    actorType: c.actorType,
    clientName: c.clientName,
    action: c.action,
    pageId: page.id,
    pageTitle: page.title,
    pageIcon: page.icon,
    pageKind: page.kind,
    databaseTitle: page.kind === 'row' ? (pages.s.get<Page>('pages', page.parentId ?? '')?.title ?? '') : '',
    fields: [...new Set(Object.keys(c.values).map((key) => label(pages, page, key, c.propertySchema)))],
    canUndo: !c.undoneAt && actor.access !== 'read' && m.role !== 'viewer',
    undoneAt: c.undoneAt,
    undoneByName: c.undoneByName,
  };
}
export function listChanges(
  pages: Pages,
  actor: Actor,
  wid: string,
  options: { actor?: string; client?: string; before?: string; limit?: number } = {},
): ChangeSummary[] {
  membership(pages.s, actor, wid);
  const filter = options.actor ?? 'ai';
  return pages.s
    .all<StoredChange>('changes')
    .filter(
      (c) =>
        c.workspaceId === wid &&
        (filter === 'all' || c.actorType === filter) &&
        (!options.client || c.clientName === options.client) &&
        (!options.before || c.at < options.before),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .flatMap((c) => {
      try {
        return [summary(pages, actor, c)];
      } catch {
        return [];
      }
    })
    .slice(0, Math.max(0, Math.min(options.limit ?? 50, 200)));
}
function change(pages: Pages, actor: Actor, key: string): StoredChange {
  const c = pages.s.get<StoredChange>('changes', key) ?? fail(404, 'Change not found.');
  pages.get(actor, c.pageId, false, true);
  return c;
}
function display(pages: Pages, actor: Actor, page: Page, key: string, value: any, schema?: Property[]): string {
  if (value == null) return '';
  if (key === 'content') return docToMarkdown(value);
  if (key === 'schema' || key === 'views') return value.map((v: any) => v.name).join(', ');
  if (key.startsWith('props.')) {
    const p = (schema ?? pages.s.get<Page>('pages', page.parentId ?? '')?.schema)?.find((p) => p.id === key.slice(6));
    return (Array.isArray(value) ? value : [value])
      .map((v) => {
        if (p?.options) return p.options.find((o) => o.id === v)?.name ?? '';
        if (p?.type === 'person') return pages.s.get('users', String(v))?.name ?? '';
        if (p?.type === 'relation') {
          try {
            return pages.get(actor, String(v)).title;
          } catch {
            return '';
          }
        }
        return String(v);
      })
      .join(';');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function changeDetail(pages: Pages, actor: Actor, key: string): ChangeDetail {
  const c = change(pages, actor, key),
    page = pages.get(actor, c.pageId, false, true);
  return {
    ...summary(pages, actor, c),
    diffs: Object.entries(c.values).map(([key, v]) => ({
      field: label(pages, page, key, c.propertySchema),
      before: display(pages, actor, page, key, v.before, c.propertySchema),
      after: display(pages, actor, page, key, v.after, c.propertySchema),
    })),
    conflict: page.updatedAt !== c.pageUpdatedAt,
  };
}
function applyUndo(
  pages: Pages,
  actor: Actor,
  c: StoredChange,
  force: boolean,
  related = false,
  expectedRows = new Map<string, string>(),
): void {
  const page = related
    ? (pages.s.get<Page>('pages', c.pageId) ?? fail(409, 'An affected row no longer exists.'))
    : pages.get(actor, c.pageId, true, true);
  if (c.undoneAt) fail(409, 'This change was already undone.');
  const expected = expectedRows.get(page.id) ?? page.updatedAt;
  if (!force && expected !== c.pageUpdatedAt) fail(409, 'Page has changed since this edit.');
  expectedRows.set(page.id, c.beforeUpdatedAt ?? '');
  for (const [key, value] of Object.entries(c.values)) {
    if (key.startsWith('props.')) {
      if (value.before === null) delete page.props[key.slice(6)];
      else page.props[key.slice(6)] = structuredClone(value.before) as PropValue;
    } else (page as any)[key] = structuredClone(value.before);
  }
  if (c.action === 'created') Object.assign(page, pages.s.get<Page>('pages', c.pageId), { deletedAt: now() });
  if ('parentId' in c.values && c.action !== 'created' && page.parentId) {
    const parent = pages.get(actor, page.parentId, true, true);
    if (
      parent.id === page.id ||
      pages.ancestors(parent).some((p) => p.id === page.id) ||
      parent.workspaceId !== page.workspaceId
    )
      fail(409, 'The old location is no longer available.');
  }
  // Persist restored schema before rebuilding affected rows' search and relation links.
  pages.change(actor, page, 'undone');
  // Schema cleanup is part of the same edit. Restore its row deltas atomically, newest first.
  for (const id of [...(c.relatedIds ?? [])].reverse()) {
    const child = pages.s.get<StoredChange>('changes', id);
    if (!child) fail(409, 'An affected row change is no longer available.');
    if (!child.undoneAt) applyUndo(pages, actor, child, force, true, expectedRows);
  }
  c.undoneAt = now();
  c.undoneByName = actor.user.name;
  pages.s.put('changes', c);
}
/**
 * `batch` carries revisions across a multi-undo: once this request has undone a newer change to a page, an older
 * change to that page is checked against the revision that newer change started from, not the undo's own write.
 */
export function undoChange(pages: Pages, actor: Actor, key: string, force = false, batch?: Map<string, string>): ChangeSummary {
  const c = change(pages, actor, key);
  const expected = new Map(batch);
  pages.s.transaction(() => applyUndo(pages, actor, c, force, false, expected));
  if (batch) for (const [k, v] of expected) batch.set(k, v);
  return summary(pages, actor, c);
}

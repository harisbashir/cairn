import type { Page, TemplateSummary } from '../../shared/types.ts';
import type { Actor } from './common.ts';
import { fail, membership } from './common.ts';
import type { Pages, StoredPage } from './pages.ts';
import type { PageCreate } from './page-validation.ts';

export function templateList(pages: Pages, actor: Actor, wid: string, databaseId?: string): TemplateSummary[] {
  membership(pages.s, actor, wid);
  if (databaseId && pages.get(actor, databaseId).kind !== 'database') fail(400, 'Templates require a database.');
  return pages
    .list(actor, wid)
    .filter(
      (p) => p.isTemplate && (p.kind === 'page' || p.kind === 'row') && (!databaseId || p.parentId === databaseId),
    )
    .map((p) => {
      const db = p.kind === 'row' && p.parentId ? pages.get(actor, p.parentId) : null;
      return {
        id: p.id,
        kind: p.kind as 'page' | 'row',
        title: p.title,
        icon: p.icon,
        databaseId: db?.id ?? null,
        databaseTitle: db?.title ?? '',
        isDefault: db?.defaultTemplateId === p.id,
        updatedAt: p.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function templateInput(
  pages: Pages,
  actor: Actor,
  wid: string,
  input: PageCreate,
  today: string,
): { input: PageCreate; template?: Page } {
  const parent = input.parentId ? pages.get(actor, input.parentId) : null;
  const templateId =
    input.templateId === undefined && !input.isTemplate && input.kind === 'row'
      ? parent?.defaultTemplateId
      : input.templateId;
  if (!templateId) return { input };
  const template = pages.get(actor, templateId);
  if (
    !template.isTemplate ||
    template.workspaceId !== wid ||
    template.kind !== (input.kind ?? 'page') ||
    (template.kind === 'row' && template.parentId !== input.parentId)
  )
    fail(400, 'Template does not match the destination.');
  const replace = (value: any): any =>
    typeof value === 'string'
      ? value.replaceAll('{{date}}', today)
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
          : value;
  const props = structuredClone(template.props);
  for (const p of parent?.schema ?? []) if (p.type === 'date' && props[p.id] === '@today') props[p.id] = today;
  return {
    template,
    input: {
      ...input,
      title: replace(input.title ?? template.title),
      icon: input.icon ?? template.icon,
      cover: input.cover ?? template.cover,
      content: input.content === undefined ? replace(template.content) : input.content,
      ...(template.kind === 'row' ? { props: { ...props, ...input.props } } : {}),
    },
  };
}
export function copyChildren(pages: Pages, actor: Actor, source: Page, target: Page, asTemplate = false): void {
  const today = pages.today(actor);
  const replace = (value: any): any =>
    asTemplate
      ? structuredClone(value)
      : typeof value === 'string'
        ? value.replaceAll('{{date}}', today)
        : Array.isArray(value)
          ? value.map(replace)
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
            : value;
  for (const child of pages
    .list(actor, source.workspaceId)
    .filter((p) => p.parentId === source.id)
    .sort((a, b) => a.position - b.position)) {
    const copy = pages.create(actor, target.workspaceId, {
      parentId: target.id,
      kind: child.kind,
      title: replace(child.title),
      icon: child.icon,
      cover: child.cover,
      content: replace(child.content),
      visibility: target.visibility,
      templateId: null,
      ...(child.kind === 'row'
        ? {
            props: Object.fromEntries(
              Object.entries(child.props).map(([key, value]) => [
                key,
                !asTemplate &&
                value === '@today' &&
                pages.s.get<Page>('pages', child.parentId ?? '')?.schema.find((p) => p.id === key)?.type === 'date'
                  ? today
                  : value,
              ]),
            ),
          }
        : {}),
      ...(child.kind === 'database'
        ? { schema: structuredClone(child.schema), views: structuredClone(child.views) }
        : {}),
    });
    copyChildren(pages, actor, child, copy, asTemplate);
  }
}
export function saveTemplate(pages: Pages, actor: Actor, pageId: string, title?: string): StoredPage {
  const original = pages.get(actor, pageId, true);
  if (original.kind === 'database') fail(400, 'Only pages and rows can be saved as templates.');
  const copy = pages.create(actor, original.workspaceId, {
    parentId: original.kind === 'row' ? original.parentId : null,
    kind: original.kind,
    title: title ?? original.title,
    icon: original.icon,
    cover: original.cover,
    content: structuredClone(original.content),
    visibility: original.visibility,
    isTemplate: true,
    templateId: null,
    ...(original.kind === 'row' ? { props: structuredClone(original.props) } : {}),
  });
  if (original.kind === 'page') copyChildren(pages, actor, original, copy, true);
  return copy;
}

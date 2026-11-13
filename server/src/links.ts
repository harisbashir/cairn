import type { DocNode, Page } from '../../shared/types.ts';
import type { Store } from './db.ts';

/** Index only local page references; embedded database views are deliberately not links. */
export function rebuildLinks(s: Store, page: Page, requestOrigin?: string): void {
  s.db.prepare('DELETE FROM links WHERE fromId=?').run(page.id);
  const found = new Map<string, Set<string>>();
  const add = (to: unknown, via: string) => {
    if (typeof to !== 'string' || !to || to === page.id) return;
    const kinds = found.get(to) ?? new Set<string>();
    kinds.add(via);
    found.set(to, kinds);
  };
  const walk = (node: DocNode): void => {
    if (node.type === 'databaseView') return;
    if (node.type === 'pageLink') add(node.attrs?.pageId, 'mention');
    for (const mark of node.marks ?? []) {
      if (mark.type !== 'link' || typeof mark.attrs?.href !== 'string') continue;
      const href = mark.attrs.href;
      let local = href.startsWith('/p/') && !href.startsWith('//');
      try {
        const origin = process.env.CAIRN_PUBLIC_URL ?? requestOrigin ?? 'http://localhost:3000';
        local ||= new URL(href).origin === new URL(origin).origin;
      } catch {
        /* Relative href. */
      }
      if (local) {
        try {
          add(/^\/p\/([^/]+)\/?$/.exec(new URL(href, 'http://cairn.local').pathname)?.[1], 'link');
        } catch {
          /* Malformed link. */
        }
      }
    }
    node.content?.forEach(walk);
  };
  if (page.content) walk(page.content);
  const schema = page.kind === 'row' && page.parentId ? (s.get<Page>('pages', page.parentId)?.schema ?? []) : [];
  for (const property of schema)
    if (property.type === 'relation') {
      const value = page.props[property.id];
      if (Array.isArray(value)) value.forEach((to) => add(to, 'relation'));
    }
  const insert = s.db.prepare('INSERT OR IGNORE INTO links(fromId,toId,via) VALUES(?,?,?)');
  for (const [to, kinds] of found) for (const via of kinds) insert.run(page.id, to, via);
}

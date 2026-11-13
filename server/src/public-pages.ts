import type { Page } from '../../shared/types.ts';
import { computeRows } from '../../shared/compute.ts';
import type { Pages, StoredPage } from './pages.ts';

/** Computation for an anonymous reader uses only independently public dependencies. */
export function publicComputed(pages: Pages, page: Page): Page {
  const allowed = (candidate: Page): boolean => {
    if (candidate.workspaceId !== page.workspaceId) return false;
    const chain = [...pages.ancestors(candidate), candidate] as StoredPage[];
    return (
      chain.every((p) => !p.deletedAt && p.visibility !== 'private' && !p.isTemplate) &&
      chain.some((p) => !!p.shareToken)
    );
  };
  if (page.kind !== 'row' || !page.parentId) return page;
  const database = pages.s.get<Page>('pages', page.parentId);
  if (!database || database.workspaceId !== page.workspaceId || database.kind !== 'database') return page;
  const getSchema = (databaseId: string) => {
    const db = pages.s.get<Page>('pages', databaseId);
    return db?.kind === 'database' && allowed(db) ? db.schema : [];
  };
  const computed = computeRows([{ ...page, isTemplate: false }], database.schema, {
    getSchema,
    getRows(databaseId) {
      const db = pages.s.get<Page>('pages', databaseId);
      if (!db || db.kind !== 'database' || !allowed(db)) return [];
      return pages.s.all<Page>('pages').filter((row) => row.parentId === db.id && row.kind === 'row' && allowed(row));
    },
  })[0];
  return { ...computed, isTemplate: page.isTemplate };
}
export function publicRows(pages: Pages, database: Page) {
  return pages.s
    .all<Page>('pages')
    .filter(
      (row) =>
        row.workspaceId === database.workspaceId &&
        row.parentId === database.id &&
        row.kind === 'row' &&
        !pages.isTemplate(row) &&
        !row.deletedAt &&
        row.visibility !== 'private',
    )
    .sort((a, b) => a.position - b.position)
    .map((row) => pages.row(publicComputed(pages, row)));
}

import type { Page, Property, Props, Reminder, Repeat } from '../../shared/types.ts';
import type { Actor } from './common.ts';
import { fail } from './common.ts';
import type { Pages } from './pages.ts';
import { parseFormula } from '../../shared/formula.ts';
import { id } from './db.ts';

export function validateSchema(
  pages: Pages,
  actor: Actor,
  workspaceId: string,
  schema: Property[],
  databaseId?: string,
  schemas: Map<string, Property[]> = new Map(),
): void {
  if (new Set(schema.map((p) => p.id)).size !== schema.length) fail(400, 'Property ids must be unique.');
  for (const p of schema) {
    if (p.type === 'formula') {
      if (!p.formula) fail(400, 'A formula requires an expression.');
      const parsed = parseFormula(p.formula.expression, schema);
      if (!parsed.ok) fail(400, parsed.message);
      p.formula.resultType = parsed.resultType;
    }
    if (p.type !== 'rollup') continue;
    const config = p.rollup;
    if (!config) fail(400, 'A rollup requires a configuration.');
    let related: Page, relation: Property | undefined;
    if (config.source.kind === 'relation') {
      relation = schema.find((p) => p.id === config.source.propertyId);
      if (relation?.type !== 'relation' || !relation.relationDatabaseId) fail(400, 'Rollup source must be a relation.');
      related = pages.get(actor, relation.relationDatabaseId);
    } else {
      related = pages.get(actor, config.source.databaseId);
      relation = (schemas.get(related.id) ?? related.schema).find((p) => p.id === config.source.propertyId);
      if (relation?.type !== 'relation' || relation.relationDatabaseId !== databaseId)
        fail(400, 'Incoming source must relate to this database.');
    }
    if (related.kind !== 'database' || related.workspaceId !== workspaceId)
      fail(400, 'Rollups must use databases in this workspace.');
    const target =
      config.target === 'title'
        ? { type: 'text' }
        : (related.id === databaseId ? schema : (schemas.get(related.id) ?? related.schema)).find(
            (p) => p.id === config.target,
          );
    if (!target) fail(400, 'Rollup target does not exist.');
    const type =
      target.type === 'formula' && 'formula' in target
        ? target.formula?.resultType
        : target.type === 'rollup' && 'rollup' in target
          ? ['earliest', 'latest'].includes(target.rollup?.fn ?? '')
            ? 'date'
            : target.rollup?.fn === 'show'
              ? 'text'
              : 'number'
          : target.type;
    if (
      (['sum', 'avg', 'min', 'max'].includes(config.fn) && type !== 'number') ||
      (['earliest', 'latest'].includes(config.fn) && type !== 'date') ||
      (config.fn === 'percent_checked' && type !== 'checkbox')
    )
      fail(400, 'Rollup function does not fit the target type.');
  }
}
export function validateProps(pages: Pages, actor: Actor, parent: Page | null, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    const property = parent?.schema.find((p) => p.id === key);
    if (!property) continue; // Existing clients may retain values for removed fields.
    if (['formula', 'rollup'].includes(property.type)) fail(400, 'Computed properties are read only.');
    if (property.type === 'files' && value !== null) {
      if (!Array.isArray(value)) fail(400, 'Files must be a list of uploaded file URLs.');
      for (const url of value) {
        const match = /^\/files\/([^/]+)\/([^/]+)$/.exec(url);
        const file = match && pages.s.get('files', match[1]);
        let name = '';
        try {
          name = decodeURIComponent(match?.[2] ?? '');
        } catch {
          /* Invalid URL. */
        }
        if (!file || file.deletedAt || file.workspaceId !== parent?.workspaceId || name !== file.name)
          fail(400, 'File must be an existing upload in this workspace.');
      }
    }
  }
}
export function validateRepeat(schema: Property[], repeat: Repeat | null, kind: Page['kind']): void {
  if (!repeat) return;
  if (!Number.isInteger(repeat.every) || repeat.every < 1 || repeat.every > 365)
    fail(400, 'Repeat interval must be between 1 and 365.');
  if (
    repeat.weekdays &&
    (!repeat.weekdays.length || repeat.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
  )
    fail(400, 'Invalid weekdays.');
  if (kind !== 'row') fail(400, 'Only rows can repeat.');
  if (repeat.weekdays && repeat.unit !== 'week') fail(400, 'Weekdays require a weekly repeat.');
  if (schema.find((p) => p.id === repeat.dateProp)?.type !== 'date') fail(400, 'Repeat date property must be a date.');
  const done = schema.find((p) => p.id === repeat.doneProp);
  if (!done || !['status', 'select', 'checkbox'].includes(done.type))
    fail(400, 'Repeat completion requires a status, select or checkbox.');
  const valid = (value: unknown) =>
    done.type === 'checkbox'
      ? typeof value === 'boolean'
      : typeof value === 'string' && done.options?.some((o) => o.id === value);
  if (!valid(repeat.doneValue) || (repeat.resetValue !== null && !valid(repeat.resetValue)))
    fail(400, 'Invalid repeat completion/reset value.');
  if (repeat.until && !Number.isFinite(Date.parse(repeat.until))) fail(400, 'Invalid repeat end date.');
}
export function normalizeReminders(
  pages: Pages,
  actor: Actor,
  page: Page,
  entries: {
    id?: string;
    dateProp: string | null;
    offsetMinutes: number;
    at: string | null;
    userIds: string[];
    personProp: string | null;
  }[],
): Reminder[] {
  if (entries.length > 10) fail(400, 'A page can have at most ten reminders.');
  const schema = page.kind === 'row' ? (pages.s.get<Page>('pages', page.parentId!)?.schema ?? []) : [];
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (!Number.isFinite(entry.offsetMinutes) || entry.offsetMinutes < 0)
      fail(400, 'Reminder offset must be nonnegative.');
    if (entry.id && seen.has(entry.id)) fail(400, 'Reminder ids must be unique.');
    if (entry.id) seen.add(entry.id);
    if (entry.dateProp) {
      if (schema.find((p) => p.id === entry.dateProp)?.type !== 'date')
        fail(400, 'Reminder date property must be a date.');
    } else if (!entry.at || !/^\d{4}-\d\d-\d\dT/.test(entry.at) || !Number.isFinite(Date.parse(entry.at)))
      fail(400, 'Absolute reminders require an ISO time.');
    if (entry.personProp && schema.find((p) => p.id === entry.personProp)?.type !== 'person')
      fail(400, 'Reminder people property must be a person property.');
    for (const userId of entry.userIds)
      if (
        !pages.s.db.prepare('SELECT 1 FROM memberships WHERE workspaceId=? AND userId=?').get(page.workspaceId, userId)
      )
        fail(400, 'Reminder recipients must belong to this workspace.');
    const previous = page.reminders.find((r) => r.id === entry.id);
    return {
      ...entry,
      id: previous?.id ?? id(),
      createdBy: previous?.createdBy ?? actor.user.id,
      lastFiredFor:
        previous &&
        JSON.stringify([
          previous.dateProp,
          previous.at,
          previous.offsetMinutes,
          previous.userIds,
          previous.personProp,
        ]) === JSON.stringify([entry.dateProp, entry.at, entry.offsetMinutes, entry.userIds, entry.personProp])
          ? previous.lastFiredFor
          : null,
    };
  });
}

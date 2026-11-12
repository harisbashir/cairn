import { z } from 'zod';
import type { DocNode } from '../../shared/types.ts';

const doc: z.ZodType<DocNode> = z.lazy(() => z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  content: z.array(doc).optional(),
  marks: z.array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
  text: z.string().optional(),
}));
const option = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.enum(['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'red']),
});
export const property = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.enum(['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'person', 'relation']),
  options: z.array(option).optional(),
  relationDatabaseId: z.string().optional(),
});
const propValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
export const view = z.object({
  id: z.string(), name: z.string(), type: z.enum(['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart', 'feed']),
  filters: z.array(z.object({
    propertyId: z.string(),
    op: z.enum(['contains', 'not_contains', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty', 'checked', 'unchecked']),
    value: propValue.optional(),
  })),
  sorts: z.array(z.object({ propertyId: z.string(), dir: z.enum(['asc', 'desc']) })),
  groupBy: z.string().optional(), hidden: z.array(z.string()).optional(),
  cardProps: z.array(z.string()).optional(), columnOrder: z.array(z.string()).optional(), hiddenColumns: z.array(z.string()).optional(),
  dateProp: z.string().optional(), endDateProp: z.string().optional(), zoom: z.enum(['week','month','quarter']).optional(), cover: z.enum(['page','none']).optional(), phone: z.enum(['auto','same']).optional(),
  chart: z.object({ kind: z.enum(['bar','donut','line']), groupBy: z.string(), measure: z.enum(['count','sum','avg']), valueProp: z.string().optional() }).optional(),
  widths: z.record(z.string(), z.number()).optional(),
});
export const pagePatch = z.object({
  title: z.string().max(10000).optional(), icon: z.string().optional(), cover: z.string().optional(),
  content: doc.nullable().optional(), props: z.record(z.string(), propValue).optional(),
  schema: z.array(property).optional(), views: z.array(view).optional(),
  visibility: z.enum(['workspace', 'private']).optional(),
});
export const pageCreate = pagePatch.extend({
  parentId: z.string().nullable().optional(),
  kind: z.enum(['page', 'database', 'row']).optional(),
  afterId: z.string().nullable().optional(),
});
export type PagePatch = z.infer<typeof pagePatch>;
export type PageCreate = z.infer<typeof pageCreate>;

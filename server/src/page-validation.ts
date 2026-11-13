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
  type: z.enum(['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'person', 'relation', 'files', 'rollup', 'formula']),
  options: z.array(option).optional(),
  relationDatabaseId: z.string().optional(),
  numberFormat: z.enum(['plain','comma','percent','currency']).optional(),
  formula: z.object({ expression: z.string().max(2000), resultType: z.enum(['text','number','checkbox','date']).optional() }).optional(),
  rollup: z.object({
    source: z.discriminatedUnion('kind', [z.object({kind:z.literal('relation'),propertyId:z.string()}), z.object({kind:z.literal('incoming'),databaseId:z.string(),propertyId:z.string()})]),
    target:z.string(), fn:z.enum(['count','count_values','sum','avg','min','max','earliest','latest','percent_checked','show']),
    filters:z.array(z.object({propertyId:z.string(),op:z.enum(['contains','not_contains','eq','neq','gt','lt','gte','lte','is_empty','is_not_empty','checked','unchecked']),value:z.union([z.string(),z.number(),z.boolean(),z.array(z.string()),z.null()]).optional()})).optional(),
  }).optional(),
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
export const repeatInput = z.object({
  dateProp:z.string(),every:z.number().int().min(1).max(365),unit:z.enum(['day','week','month','year']),
  weekdays:z.array(z.number().int().min(0).max(6)).min(1).optional(),from:z.enum(['due','completed']),until:z.string().regex(/^\d{4}-\d\d-\d\d$/).nullable(),
  doneProp:z.string(),doneValue:z.union([z.string(),z.boolean()]),resetValue:z.union([z.string(),z.boolean(),z.null()]),
});
export const reminderInput = z.object({
  id:z.string().optional(), dateProp:z.string().nullable(),offsetMinutes:z.number().min(0),at:z.string().nullable(),userIds:z.array(z.string()),personProp:z.string().nullable(),createdBy:z.string().optional(),lastFiredFor:z.string().nullable().optional(),
});
export const pagePatch = z.object({
  title: z.string().max(10000).optional(), icon: z.string().optional(), cover: z.string().optional(),
  content: doc.nullable().optional(), props: z.record(z.string(), propValue).optional(),
  schema: z.array(property).optional(), views: z.array(view).optional(),
  visibility: z.enum(['workspace', 'private']).optional(),
  repeat:repeatInput.nullable().optional(),reminders:z.array(reminderInput).max(10).optional(),isTemplate:z.boolean().optional(),defaultTemplateId:z.string().min(1).nullable().optional(),
});
export const pageCreate = pagePatch.extend({
  parentId: z.string().nullable().optional(),
  kind: z.enum(['page', 'database', 'row']).optional(),
  afterId: z.string().nullable().optional(),
  templateId:z.string().min(1).nullable().optional(),
});
export type PagePatch = z.infer<typeof pagePatch>;
export type PageCreate = z.infer<typeof pageCreate>;

import type { Property, Props, PropValue } from './types.ts';
import { parseFormula, evaluateFormula } from './formula.ts';
import { applyView } from './query.ts';

export interface ComputeRow {
  id: string;
  title: string;
  props: Props;
  isTemplate?: boolean;
}
export interface ComputeContext {
  getRows(databaseId: string): ComputeRow[];
  getSchema(databaseId: string): Property[];
  getPersonName?(id: string): string;
  now?: Date;
  today?: string;
  thisPageId?: string;
  userId?: string;
}
const formulaCache = new Map<string, ReturnType<typeof parseFormula>>();
const empty = (value: PropValue | undefined) =>
  value == null || value === '' || (Array.isArray(value) && !value.length);
const computed = (property: Property) => property.type === 'formula' || property.type === 'rollup';

/** Evaluate a dependency graph of cells, including cells in related databases. */
export function computeRows<T extends ComputeRow>(rows: T[], schema: Property[], ctx: ComputeContext): T[] {
  const values = new Map<string, PropValue>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const databaseRows = new Map<string, ComputeRow[]>();
  const relatedRows = (databaseId: string) => {
    if (!databaseRows.has(databaseId))
      databaseRows.set(
        databaseId,
        ctx.getRows(databaseId).filter((row) => !row.isTemplate),
      );
    return databaseRows.get(databaseId)!;
  };
  const display = (value: PropValue | undefined, property?: Property): PropValue => {
    if (value == null) return null;
    if (property?.options) {
      return (Array.isArray(value) ? value : [value])
        .map((id) => property.options!.find((option) => option.id === id)?.name ?? String(id))
        .join(', ');
    }
    if (property?.type === 'person' && Array.isArray(value))
      return value.map((id) => ctx.getPersonName?.(id) ?? id).join(', ');
    if (property?.type === 'relation' && Array.isArray(value)) {
      const linked = property.relationDatabaseId ? relatedRows(property.relationDatabaseId) : [];
      return value
        .map((id) => linked.find((row) => row.id === id)?.title ?? '')
        .filter(Boolean)
        .join(', ');
    }
    if (property?.type === 'files' && Array.isArray(value))
      return value.map((url) => decodeURIComponent(url.split('/').at(-1) ?? url)).join(', ');
    return Array.isArray(value) ? value.join(', ') : value;
  };
  const resolve = (row: ComputeRow, properties: Property[], property: Property): PropValue => {
    if (!computed(property)) return row.props[property.id] ?? null;
    const key = JSON.stringify([row.id, property.id]);
    if (values.has(key)) return values.get(key)!;
    const cycleStart = stack.indexOf(key);
    if (cycleStart >= 0) {
      for (const cell of stack.slice(cycleStart)) cycles.add(cell);
      throw new Error('Computed property cycle');
    }
    stack.push(key);
    let value: PropValue = null;
    try {
      if (property.type === 'formula') {
        const expression = property.formula?.expression ?? '';
        // A schema signature also invalidates inferred types after an in-place schema edit.
        const signature = JSON.stringify([expression, properties]);
        let parsed = formulaCache.get(signature);
        if (!parsed) {
          parsed = parseFormula(expression, properties);
          if (formulaCache.size >= 256) formulaCache.clear();
          formulaCache.set(signature, parsed);
        }
        value = evaluateFormula(parsed, {
          now: ctx.now,
          today: ctx.today,
          getProperty(name) {
            if (name === 'title' || (name === 'Name' && !properties.some((property) => property.name === 'Name')))
              return row.title;
            const target = properties.find((property) => property.name === name || property.id === name);
            return target ? display(resolve(row, properties, target), target) : undefined;
          },
        });
      } else if (property.rollup) {
        const config = property.rollup;
        const source = config.source;
        const relation =
          source.kind === 'relation' ? properties.find((property) => property.id === source.propertyId) : undefined;
        const databaseId = source.kind === 'incoming' ? source.databaseId : relation?.relationDatabaseId;
        if (databaseId) {
          const targetSchema = ctx.getSchema(databaseId);
          const ids = row.props[source.propertyId];
          let related = relatedRows(databaseId).filter((related) =>
            source.kind === 'incoming'
              ? Array.isArray(related.props[source.propertyId]) &&
                (related.props[source.propertyId] as string[]).includes(row.id)
              : Array.isArray(ids) && ids.includes(related.id),
          );
          // Resolve only referenced cells: unrelated computed columns cannot introduce cycles.
          const needed = new Set([
            ...(config.fn === 'count' ? [] : [config.target]),
            ...(config.filters ?? []).map((filter) => filter.propertyId),
          ]);
          related = related.map((related) => {
            const props = { ...related.props };
            for (const target of targetSchema)
              if (needed.has(target.id)) props[target.id] = resolve(related, targetSchema, target);
            return { ...related, props };
          });
          if (config.filters?.length)
            related = applyView(
              related.map((related) => ({ ...related, createdAt: '', updatedAt: '', position: 0 })),
              { filters: config.filters, sorts: [] },
              targetSchema,
              { ...ctx, thisPageId: row.id },
            );
          const target = targetSchema.find((property) => property.id === config.target);
          const items = related.map((related) =>
            config.target === 'title' ? related.title : related.props[config.target],
          );
          const present = items.filter((item) => !empty(item));
          const numbers = present.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
          switch (config.fn) {
            case 'count':
              value = related.length;
              break;
            case 'count_values':
              value = present.length;
              break;
            case 'sum':
              value = numbers.reduce((sum, item) => sum + item, 0);
              break;
            case 'avg':
              value = numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : null;
              break;
            case 'min':
              value = numbers.length ? Math.min(...numbers) : null;
              break;
            case 'max':
              value = numbers.length ? Math.max(...numbers) : null;
              break;
            case 'percent_checked':
              value = items.length ? (100 * items.filter((item) => item === true).length) / items.length : 0;
              break;
            case 'earliest':
            case 'latest': {
              const dates = present
                .filter((item): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item)))
                .sort((a, b) => Date.parse(a) - Date.parse(b));
              value = (config.fn === 'earliest' ? dates[0] : dates.at(-1)) ?? null;
              break;
            }
            case 'show':
              value = present.map((item) => String(display(item, target) ?? ''));
              break;
          }
        }
      }
    } catch {
      value = null;
    }
    stack.pop();
    if (cycles.has(key)) value = null;
    values.set(key, value);
    return value;
  };
  return rows
    .filter((row) => !row.isTemplate)
    .map((row) => {
      const props = { ...row.props };
      for (const property of schema.filter((property) => property.type === 'rollup'))
        props[property.id] = resolve(row, schema, property);
      for (const property of schema.filter((property) => property.type === 'formula'))
        props[property.id] = resolve(row, schema, property);
      return { ...row, props };
    });
}

import type { Filter, Property, Props, PropValue, View } from './types.ts';

type QueryRow = { title: string; props: Props; createdAt: string; updatedAt: string; position: number };
const empty = (value: PropValue | undefined) =>
  value == null || value === '' || (Array.isArray(value) && value.length === 0);

const dateProperty = (property?: Property) =>
  property?.type === 'date' ||
  property?.formula?.resultType === 'date' ||
  (property?.rollup && ['earliest', 'latest'].includes(property.rollup.fn));
function normalized(value: PropValue | undefined, property?: Property, dayOnly = false): string | number | boolean {
  if (value == null) return '';
  if (dateProperty(property)) return dayOnly ? String(value).slice(0, 10) : Date.parse(String(value));
  if (typeof value === 'string') return value.toLocaleLowerCase();
  if (Array.isArray(value)) return value.join(',').toLocaleLowerCase();
  return value;
}

function matches(value: PropValue | undefined, filter: Filter, property?: Property): boolean {
  if (filter.op === 'is_empty') return empty(value);
  if (filter.op === 'is_not_empty') return !empty(value);
  if (filter.op === 'checked') return value === true;
  if (filter.op === 'unchecked') return value !== true;
  const arrayType = property && ['multi_select', 'person', 'relation'].includes(property.type);
  const optionType = property && ['select', 'status'].includes(property.type);
  const dayOnly = dateProperty(property) && typeof filter.value === 'string' && filter.value.length === 10;
  const a = normalized(value, property, !!dayOnly);
  const b = normalized(filter.value, property, !!dayOnly);
  switch (filter.op) {
    case 'contains':
      return arrayType ? Array.isArray(value) && value.includes(String(filter.value)) : String(a).includes(String(b));
    case 'not_contains':
      return arrayType
        ? !Array.isArray(value) || !value.includes(String(filter.value))
        : !String(a).includes(String(b));
    case 'eq':
      return arrayType
        ? Array.isArray(value) && value.includes(String(filter.value))
        : optionType
          ? value === filter.value
          : a === b;
    case 'neq':
      return arrayType
        ? !Array.isArray(value) || !value.includes(String(filter.value))
        : optionType
          ? value !== filter.value
          : a !== b;
    case 'gt':
      return !empty(value) && a > b;
    case 'lt':
      return !empty(value) && a < b;
    case 'gte':
      return !empty(value) && a >= b;
    case 'lte':
      return !empty(value) && a <= b;
    default:
      return true;
  }
}

export interface ViewContext {
  thisPageId?: string;
  userId?: string;
  today?: string;
}
export function applyView<T extends QueryRow>(
  rows: T[],
  view: Pick<View, 'filters' | 'sorts'>,
  schema: Property[],
  ctx: ViewContext = {},
): T[] {
  const filters = view.filters.map((filter) => ({
    ...filter,
    value:
      filter.value === '@this'
        ? (ctx.thisPageId ?? null)
        : filter.value === '@me'
          ? (ctx.userId ?? null)
          : filter.value === '@today'
            ? (ctx.today ?? new Date().toISOString().slice(0, 10))
            : filter.value,
  }));
  const properties = new Map(schema.map((property) => [property.id, property]));
  const filtered = rows.filter((row) =>
    filters.every((filter) => {
      const property = properties.get(filter.propertyId);
      if (filter.propertyId !== 'title' && !property) return true;
      return matches(filter.propertyId === 'title' ? row.title : row.props[filter.propertyId], filter, property);
    }),
  );
  const sorts = view.sorts.filter(
    (sort) => ['title', 'createdAt', 'updatedAt'].includes(sort.propertyId) || properties.has(sort.propertyId),
  );
  return filtered.sort((a, b) => {
    for (const sort of sorts) {
      const property = properties.get(sort.propertyId);
      const get = (row: T): string | number | boolean => {
        if (sort.propertyId === 'title') return row.title.toLocaleLowerCase();
        if (sort.propertyId === 'createdAt' || sort.propertyId === 'updatedAt') return row[sort.propertyId];
        const value = row.props[sort.propertyId];
        if (property?.options && ['select', 'status', 'multi_select'].includes(property.type)) {
          const ids = Array.isArray(value) ? value : [value];
          const indexes = ids
            .map((id) => property.options!.findIndex((option) => option.id === id))
            .filter((index) => index >= 0);
          return indexes.length ? Math.min(...indexes) : -1;
        }
        return normalized(value, property);
      };
      const av = get(a),
        bv = get(b);
      const comparison = av < bv ? -1 : av > bv ? 1 : 0;
      if (comparison) return sort.dir === 'desc' ? -comparison : comparison;
    }
    return a.position - b.position;
  });
}

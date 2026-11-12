import type { Filter, Property, Props, PropValue, View } from './types.ts';

type QueryRow = { title: string; props: Props; createdAt: string; updatedAt: string; position: number };
const empty = (value: PropValue | undefined) => value == null || value === '' || (Array.isArray(value) && value.length === 0);

function normalized(value: PropValue | undefined, property?: Property): string | number | boolean {
  if (value == null) return '';
  if (property?.type === 'date') return String(value).slice(0, 10);
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
  const a = normalized(value, property);
  const b = normalized(filter.value, property);
  switch (filter.op) {
    case 'contains': return arrayType ? Array.isArray(value) && value.includes(String(filter.value)) : String(a).includes(String(b));
    case 'not_contains': return arrayType ? !Array.isArray(value) || !value.includes(String(filter.value)) : !String(a).includes(String(b));
    case 'eq': return optionType ? value === filter.value : a === b;
    case 'neq': return optionType ? value !== filter.value : a !== b;
    case 'gt': return !empty(value) && a > b;
    case 'lt': return !empty(value) && a < b;
    case 'gte': return !empty(value) && a >= b;
    case 'lte': return !empty(value) && a <= b;
    default: return true;
  }
}

export function applyView<T extends QueryRow>(rows: T[], view: Pick<View, 'filters' | 'sorts'>, schema: Property[]): T[] {
  const properties = new Map(schema.map(property => [property.id, property]));
  const filtered = rows.filter(row => view.filters.every(filter => {
    const property = properties.get(filter.propertyId);
    if (filter.propertyId !== 'title' && !property) return true;
    return matches(filter.propertyId === 'title' ? row.title : row.props[filter.propertyId], filter, property);
  }));
  const sorts = view.sorts.filter(sort => ['title', 'createdAt', 'updatedAt'].includes(sort.propertyId) || properties.has(sort.propertyId));
  return filtered.sort((a, b) => {
    for (const sort of sorts) {
      const property = properties.get(sort.propertyId);
      const get = (row: T): string | number | boolean => {
        if (sort.propertyId === 'title') return row.title.toLocaleLowerCase();
        if (sort.propertyId === 'createdAt' || sort.propertyId === 'updatedAt') return row[sort.propertyId];
        const value = row.props[sort.propertyId];
        if (property?.options && ['select', 'status', 'multi_select'].includes(property.type)) {
          const ids = Array.isArray(value) ? value : [value];
          const indexes = ids.map(id => property.options!.findIndex(option => option.id === id)).filter(index => index >= 0);
          return indexes.length ? Math.min(...indexes) : -1;
        }
        return normalized(value, property);
      };
      const av = get(a), bv = get(b);
      const comparison = av < bv ? -1 : av > bv ? 1 : 0;
      if (comparison) return sort.dir === 'desc' ? -comparison : comparison;
    }
    return a.position - b.position;
  });
}

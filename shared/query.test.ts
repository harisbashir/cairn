import { describe, expect, it } from 'vitest';
import { applyView } from './query.ts';
import type { Property, Props, Filter } from './types.ts';
const schema: Property[] = [
  { id: 'status', name: 'Status', type: 'status', options: [{ id: 'z', name: 'First', color: 'gray' }, { id: 'a', name: 'Second', color: 'blue' }] },
  { id: 'tags', name: 'Tags', type: 'multi_select' }, { id: 'date', name: 'Date', type: 'date' },
  { id: 'number', name: 'Number', type: 'number' }, { id: 'done', name: 'Done', type: 'checkbox' },
];
const row = (title: string, position: number, props: Props = {}) => ({ title, position, props, createdAt: '2026-01-01', updatedAt: '2026-02-01' });
const rows = [row('Alpha', 2, { status: 'a', tags: ['x'], date: '2026-05-02T20:00:00Z', number: 3, done: true }), row('BETA', 1, { status: 'z', tags: [], date: '2026-05-01', number: 0 })];
describe('applyView', () => {
  it('sorts by position without mutating the input', () => {
    expect(applyView(rows, { filters: [], sorts: [] }, schema).map(r => r.title)).toEqual(['BETA', 'Alpha']);
    expect(rows[0].title).toBe('Alpha');
  });
  it('ANDs filters and ignores unknown properties', () => {
    const filters: Filter[] = [{ propertyId: 'title', op: 'contains', value: 'AL' }, { propertyId: 'tags', op: 'contains', value: 'x' }, { propertyId: 'missing', op: 'eq', value: 'anything' }];
    expect(applyView(rows, { filters, sorts: [] }, schema)).toEqual([rows[0]]);
  });
  it('compares option ids and sorts by schema option order', () => {
    expect(applyView(rows, { filters: [], sorts: [{ propertyId: 'status', dir: 'asc' }] }, schema)[0]).toBe(rows[1]);
    expect(applyView(rows, { filters: [{ propertyId: 'status', op: 'eq', value: 'z' }], sorts: [] }, schema)).toEqual([rows[1]]);
  });
  it('handles dates, zero, checkboxes, emptiness and descending sorts', () => {
    for (const filter of [
      { propertyId: 'date', op: 'eq', value: '2026-05-02' }, { propertyId: 'number', op: 'gt', value: 0 }, { propertyId: 'done', op: 'checked' }, { propertyId: 'tags', op: 'is_not_empty' },
    ] satisfies Filter[]) expect(applyView(rows, { filters: [filter], sorts: [] }, schema)).toEqual([rows[0]]);
    expect(applyView(rows, { filters: [{ propertyId: 'number', op: 'is_empty' }], sorts: [] }, schema)).toEqual([]);
    expect(applyView(rows, { filters: [], sorts: [{ propertyId: 'title', dir: 'desc' }] }, schema)[0]).toBe(rows[1]);
  });
});

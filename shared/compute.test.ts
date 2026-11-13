import { expect, it } from 'vitest';
import { computeRows, type ComputeRow } from './compute.ts';
import type { Property } from './types.ts';
it('computes filtered incoming rollups before formulas without mutation', () => {
  const rows = [{ id: 'p', title: 'Project', props: {} }];
  const tasks = [
    { id: 't', title: 'Task', props: { project: ['p'], n: 4 } },
    { id: 'template', title: 'Hidden', props: { project: ['p'], n: 9 }, isTemplate: true },
  ];
  const schema: Property[] = [
    {
      id: 'sum',
      name: 'Total',
      type: 'rollup',
      rollup: {
        source: { kind: 'incoming', databaseId: 'tasks', propertyId: 'project' },
        target: 'n',
        fn: 'sum',
        filters: [{ propertyId: 'n', op: 'gt', value: 2 }],
      },
    },
    { id: 'double', name: 'Double', type: 'formula', formula: { expression: 'prop("Total") * 2' } },
  ];
  expect(
    computeRows(rows, schema, { getRows: () => tasks, getSchema: () => [{ id: 'n', name: 'N', type: 'number' }] })[0]
      .props,
  ).toEqual({ sum: 4, double: 8 });
  expect(rows[0].props).toEqual({});
});
it('detects formula cycles', () => {
  const schema: Property[] = [
    { id: 'a', name: 'A', type: 'formula', formula: { expression: 'prop("B")' } },
    { id: 'b', name: 'B', type: 'formula', formula: { expression: 'prop("A")' } },
  ];
  expect(
    computeRows([{ id: 'r', title: 'Row', props: {} }], schema, { getRows: () => [], getSchema: () => [] })[0].props,
  ).toEqual({ a: null, b: null });
});
it('implements every outgoing aggregation and display names', () => {
  const targets: ComputeRow[] = [
    { id: 'a', title: 'Alpha', props: { n: 2, d: '2026-01-01', check: true, s: 'yes' } },
    { id: 'b', title: 'Beta', props: { n: 4, d: '2026-02-01', check: false, s: 'yes' } },
    { id: 'c', title: 'Empty', props: {} },
  ];
  const targetSchema: Property[] = [
    { id: 'n', name: 'N', type: 'number' },
    { id: 'd', name: 'Date', type: 'date' },
    { id: 'check', name: 'Check', type: 'checkbox' },
    { id: 's', name: 'State', type: 'select', options: [{ id: 'yes', name: 'Ready', color: 'green' }] },
  ];
  const entries = [
    ['count', 'n', 3],
    ['count_values', 'n', 2],
    ['sum', 'n', 6],
    ['avg', 'n', 3],
    ['min', 'n', 2],
    ['max', 'n', 4],
    ['earliest', 'd', '2026-01-01'],
    ['latest', 'd', '2026-02-01'],
    ['percent_checked', 'check', 100 / 3],
    ['show', 's', ['Ready', 'Ready']],
  ] as const;
  for (const [fn, target, expected] of entries) {
    const schema: Property[] = [
      { id: 'rel', name: 'Relation', type: 'relation', relationDatabaseId: 'db' },
      {
        id: 'r',
        name: 'Rollup',
        type: 'rollup',
        rollup: { source: { kind: 'relation', propertyId: 'rel' }, target, fn },
      },
    ];
    expect(
      computeRows<ComputeRow>([{ id: 'row', title: 'Row', props: { rel: ['a', 'b', 'c'] } }], schema, {
        getRows: () => targets,
        getSchema: () => targetSchema,
      })[0].props.r,
      fn,
    ).toEqual(expected);
  }
});
it('exposes option, people, relation and title display values to formulas', () => {
  const schema: Property[] = [
    { id: 's', name: 'Status', type: 'select', options: [{ id: 'x', name: 'Done', color: 'green' }] },
    { id: 'p', name: 'People', type: 'person' },
    { id: 'r', name: 'Related', type: 'relation', relationDatabaseId: 'db' },
    {
      id: 'f',
      name: 'Formula',
      type: 'formula',
      formula: { expression: 'concat(prop("title"), prop("Status"), prop("People"), prop("Related"))' },
    },
  ];
  expect(
    computeRows<ComputeRow>([{ id: 'a', title: 'Task', props: { s: 'x', p: ['u'], r: ['b'] } }], schema, {
      getRows: () => [{ id: 'b', title: 'Other', props: {} }],
      getSchema: () => [],
      getPersonName: () => 'Ada',
    })[0].props.f,
  ).toBe('TaskDoneAdaOther');
});
it('computes related formula targets and filters, with cross-database cycles returning null', () => {
  const targetSchema: Property[] = [
    { id: 'n', name: 'N', type: 'number' },
    { id: 'f', name: 'Double', type: 'formula', formula: { expression: 'prop("N") * 2' } },
  ];
  const schema: Property[] = [
    { id: 'rel', name: 'Relation', type: 'relation', relationDatabaseId: 'other' },
    {
      id: 'r',
      name: 'Total',
      type: 'rollup',
      rollup: {
        source: { kind: 'relation', propertyId: 'rel' },
        target: 'f',
        fn: 'sum',
        filters: [{ propertyId: 'f', op: 'gte', value: 6 }],
      },
    },
  ];
  const result = computeRows<ComputeRow>([{ id: 'root', title: 'Root', props: { rel: ['a', 'b'] } }], schema, {
    getSchema: () => targetSchema,
    getRows: () => [
      { id: 'a', title: 'A', props: { n: 2 } },
      { id: 'b', title: 'B', props: { n: 3 } },
    ],
  });
  expect(result[0].props.r).toBe(6);
});
it('does not reuse parsed formulas after a schema expression changes in place', () => {
  const schema: Property[] = [{ id: 'f', name: 'F', type: 'formula', formula: { expression: '1' } }];
  const rows: ComputeRow[] = [{ id: 'r', title: 'Row', props: {} }];
  const ctx = { getRows: () => [], getSchema: () => [] };
  expect(computeRows(rows, schema, ctx)[0].props.f).toBe(1);
  schema[0].formula!.expression = '2';
  expect(computeRows(rows, schema, ctx)[0].props.f).toBe(2);
});
it('terminates cross-database dependency cycles even through lazy formulas', () => {
  const aSchema: Property[] = [
    { id: 'rel', name: 'B', type: 'relation', relationDatabaseId: 'B' },
    {
      id: 'r',
      name: 'Total',
      type: 'rollup',
      rollup: { source: { kind: 'relation', propertyId: 'rel' }, target: 'f', fn: 'sum' },
    },
  ];
  const bSchema: Property[] = [
    { id: 'rel', name: 'A', type: 'relation', relationDatabaseId: 'A' },
    {
      id: 'r',
      name: 'Back',
      type: 'rollup',
      rollup: { source: { kind: 'relation', propertyId: 'rel' }, target: 'r', fn: 'sum' },
    },
    { id: 'f', name: 'F', type: 'formula', formula: { expression: 'if(empty(prop("Back")), 4, prop("Back"))' } },
  ];
  const a: ComputeRow = { id: 'a', title: 'A', props: { rel: ['b'] } },
    b: ComputeRow = { id: 'b', title: 'B', props: { rel: ['a'] } };
  expect(
    computeRows([a], aSchema, {
      getRows: (db) => (db === 'A' ? [a] : [b]),
      getSchema: (db) => (db === 'A' ? aSchema : bSchema),
    })[0].props.r,
  ).toBeNull();
});

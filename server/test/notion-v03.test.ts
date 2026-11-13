import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { Notion } from '../src/notion.ts';
let dir: string, pages: Pages, actor: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notion-v03-'));
  const s = new Store(dir);
  pages = new Pages(s, new Events());
  actor = {
    user: { id: 'owner', name: 'Owner', disabled: false, prefs: { timezone: 'UTC' } },
    actorType: 'user',
    clientId: null,
  };
  s.put('users', actor.user);
  s.put('workspaces', { id: 'w' });
  s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('w', 'owner', 'owner', '');
});
afterEach(() => {
  pages.s.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});
it('exports computed primitives and filenames with matching writable Notion schemas, excluding templates', async () => {
  const related = pages.create(actor, 'w', {
    kind: 'database',
    title: 'Related',
    schema: [
      { id: 'n', name: 'Number', type: 'number' },
      { id: 'd', name: 'Date', type: 'date' },
    ],
  });
  const target = pages.create(actor, 'w', {
    kind: 'row',
    parentId: related.id,
    title: 'Linked',
    props: { n: 7, d: '2026-11-12' },
  });
  const db = pages.create(actor, 'w', {
    kind: 'database',
    title: 'Export',
    schema: [
      { id: 'rel', name: 'Related', type: 'relation', relationDatabaseId: related.id },
      { id: 'fn', name: 'Formula number', type: 'formula', formula: { expression: '2 * 3' } },
      { id: 'fb', name: 'Formula boolean', type: 'formula', formula: { expression: 'true' } },
      { id: 'fd', name: 'Formula date', type: 'formula', formula: { expression: 'dateAdd("2026-11-12", 1, "days")' } },
      { id: 'ft', name: 'Formula text', type: 'formula', formula: { expression: '"hello"' } },
      {
        id: 'sum',
        name: 'Rollup sum',
        type: 'rollup',
        rollup: { source: { kind: 'relation', propertyId: 'rel' }, target: 'n', fn: 'sum' },
      },
      {
        id: 'date',
        name: 'Rollup date',
        type: 'rollup',
        rollup: { source: { kind: 'relation', propertyId: 'rel' }, target: 'd', fn: 'earliest' },
      },
      {
        id: 'show',
        name: 'Rollup show',
        type: 'rollup',
        rollup: { source: { kind: 'relation', propertyId: 'rel' }, target: 'title', fn: 'show' },
      },
      { id: 'files', name: 'Files', type: 'files' },
    ],
  });
  pages.s.put('files', { id: 'upload', name: 'report one.pdf', workspaceId: 'w' });
  const row = pages.create(actor, 'w', {
    kind: 'row',
    parentId: db.id,
    title: 'Real row',
    props: { rel: [target.id], files: ['/files/upload/report%20one.pdf'] },
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep body' }] }] },
  });
  pages.create(actor, 'w', { kind: 'row', parentId: db.id, title: 'Hidden row', isTemplate: true });
  const child = pages.create(actor, 'w', { parentId: row.id, title: 'Visible child' });
  // Templates normally live at the root; simulate legacy child template data.
  const template = pages.create(actor, 'w', { title: 'Hidden child', isTemplate: true });
  template.parentId = row.id;
  pages.s.put('pages', template);
  const requests: any[] = [];
  vi.useFakeTimers();
  const fetcher = vi.fn(async (input: any, init: any) => {
    const data = JSON.parse(init.body);
    const path = new URL(String(input)).pathname;
    requests.push({ path, ...data });
    return Response.json(
      path.endsWith('/databases')
        ? { id: 'db', data_sources: [{ id: 'source' }] }
        : data.children
          ? { results: data.children.map((_: any, i: number) => ({ id: 'block' + i })) }
          : { id: 'created' },
    );
  });
  const promise = new Notion(pages, actor, 'w', 'secret', fetcher as typeof fetch).export(db.id, 'parent', () => {});
  await vi.runAllTimersAsync();
  await promise;
  const schema = requests.find((r) => r.path.endsWith('/databases')).initial_data_source.properties;
  expect(schema['Formula number']).toEqual({ number: {} });
  expect(schema['Formula boolean']).toEqual({ checkbox: {} });
  expect(schema['Formula date']).toEqual({ date: {} });
  expect(schema['Formula text']).toEqual({ rich_text: {} });
  expect(schema['Rollup sum']).toEqual({ number: {} });
  expect(schema['Rollup date']).toEqual({ date: {} });
  expect(schema['Rollup show']).toEqual({ rich_text: {} });
  expect(schema.Files).toEqual({ rich_text: {} });
  const rows = requests.filter((r) => r.parent?.type === 'data_source_id');
  expect(rows).toHaveLength(1);
  const values = rows[0].properties;
  expect(values['Formula number']).toEqual({ number: 6 });
  expect(values['Formula boolean']).toEqual({ checkbox: true });
  expect(values['Formula date']).toEqual({ date: { start: '2026-11-13' } });
  expect(values['Rollup sum']).toEqual({ number: 7 });
  expect(values['Rollup date']).toEqual({ date: { start: '2026-11-12' } });
  expect(values['Rollup show'].rich_text[0].text.content).toBe('Linked');
  expect(values.Files.rich_text[0].text.content).toBe('report one.pdf');
  expect(
    requests
      .filter((r) => r.parent?.type === 'page_id' && r.path.endsWith('/pages'))
      .map((r) => r.properties.title.title[0].text.content),
  ).toEqual([child.title]);
  expect(JSON.stringify(requests)).toContain('Keep body');
  expect(pages.s.get('pages', row.id).props.fn).toBeUndefined();
});

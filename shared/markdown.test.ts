import { describe, expect, it } from 'vitest';
import { docToMarkdown, docToPlainText, markdownToDoc } from './markdown.ts';
import type { DocNode } from './types.ts';
const text = (value: string): DocNode => ({ type: 'text', text: value });
const paragraph = (value: string): DocNode => ({ type: 'paragraph', content: [text(value)] });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

describe('Markdown conversion', () => {
  it('round trips all block types, nesting, tasks, code, images and callouts', () => {
    const source = doc(
      paragraph('Hello *literal* _under_ [bracket] #heading <html> ==equal=='),
      { type: 'heading', attrs: { level: 1 }, content: [text('Heading')] },
      { type: 'heading', attrs: { level: 3 }, content: [text('Subheading')] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              paragraph('First'),
              { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Nested')] }] },
            ],
          },
          { type: 'listItem', content: [paragraph('Second')] },
        ],
      },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('Three')] }] },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [paragraph('Done')] },
          { type: 'taskItem', attrs: { checked: false }, content: [paragraph('Open')] },
        ],
      },
      { type: 'blockquote', content: [paragraph('Quote'), paragraph('Another paragraph')] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const code = `literal`;\n```')] },
      { type: 'horizontalRule' },
      { type: 'image', attrs: { src: 'https://example.com/image.png', alt: 'An image' } },
      { type: 'callout', attrs: { emoji: '🦉' }, content: [paragraph('Think about this'), paragraph('And this')] },
      { type: 'paragraph', content: [] },
    );
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
  });
  it('round trips every inline mark, hard breaks and page links', () => {
    const content: DocNode[] = [];
    for (const mark of ['bold', 'italic', 'strike', 'code', 'highlight']) {
      content.push({ type: 'text', text: mark, marks: [{ type: mark }] }, text(' '));
    }
    content.push(
      { type: 'text', text: 'website', marks: [{ type: 'link', attrs: { href: 'https://example.com/path' } }] },
      { type: 'hardBreak' },
      { type: 'pageLink', attrs: { pageId: '1234567890123456', title: 'Related page' } },
    );
    const source = doc({ type: 'paragraph', content });
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
  });
  it('parses ordinary Markdown and handles null and blank documents', () => {
    expect(markdownToDoc('# Hello\n\n- [x] done\n- [ ] waiting').content?.map((n) => n.type)).toEqual([
      'heading',
      'taskList',
    ]);
    expect(docToMarkdown(null)).toBe('');
    expect(markdownToDoc('')).toEqual(doc());
    expect(docToPlainText(null)).toBe('');
  });
  it('extracts readable plain text with no mark syntax', () => {
    const source = markdownToDoc(
      '# Heading\n\nHello **world**  \nnext\n\n- first\n- second\n\n[Page](cairn://page/1234567890123456)',
    );
    expect(docToPlainText(source)).toBe('Heading\nHello world\nnext\nfirst\nsecond\nPage');
  });
  it('preserves literal Markdown punctuation, entities, combined marks and marked whitespace', () => {
    const source = doc(paragraph('- item'), paragraph('1. number'), paragraph('&amp; &quot;'), {
      type: 'paragraph',
      content: [
        { type: 'text', text: ' hello ', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'highlight' }] },
        { type: 'pageLink', attrs: { pageId: '1234567890123456', title: 'A [b] *c* &amp;' } },
      ],
    });
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
  });
  it('preserves inline code containing backticks and HTML entities', () => {
    const source = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: '`<&`', marks: [{ type: 'code' }] }, text(' & < >')],
    });
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
  });
  it('preserves code combined with other marks regardless of input mark order', () => {
    for (const type of ['bold', 'italic', 'strike', 'highlight', 'link']) {
      const outer = { type, ...(type === 'link' ? { attrs: { href: 'https://example.com' } } : {}) };
      for (const marks of [
        [{ type: 'code' }, outer],
        [outer, { type: 'code' }],
      ]) {
        const source = doc({ type: 'paragraph', content: [{ type: 'text', text: 'literal * <&', marks }] });
        const result = markdownToDoc(docToMarkdown(source));
        expect(result).toEqual(
          doc({
            type: 'paragraph',
            content: [{ type: 'text', text: 'literal * <&', marks: [outer, { type: 'code' }] }],
          }),
        );
      }
    }
  });
  it('preserves URL attributes with spaces, parentheses and existing percent escapes', () => {
    const href = 'https://example.com/a b(c)/already%20escaped?q=a&b=c';
    const source = doc(
      { type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }] }] },
      { type: 'image', attrs: { src: href, alt: 'Picture' } },
    );
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
    expect(
      markdownToDoc('[external](https://example.com/a%20b)').content?.[0].content?.[0].marks?.[0].attrs?.href,
    ).toBe('https://example.com/a%20b');
  });
});

it('round trips v0.3 mentions, details and tables', () => {
  const source =
    '<details><summary>Summary</summary>\n\nBody @[Ada](cairn://user/u)\n\n</details>\n\n| A | B |\n| --- | --- |\n| one<br>two | three |';
  const doc = markdownToDoc(source);
  expect(doc.content?.[0].type).toBe('details');
  expect(doc.content?.[1].type).toBe('table');
  expect(docToPlainText(doc)).toContain('Ada');
  expect(docToMarkdown(doc)).toContain('cairn://user/u');
});
it('exports columns and linked views and preserves nested details', () => {
  const doc: DocNode = {
    type: 'doc',
    content: [
      {
        type: 'columns',
        content: [
          { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Left' }] }] },
          {
            type: 'column',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'mention', attrs: { kind: 'date', id: '2026-11-12', label: 'Today' } }],
              },
            ],
          },
        ],
      },
      { type: 'databaseView', attrs: { databaseId: 'db', viewId: 'v', title: 'Tasks' } },
    ],
  };
  const md = docToMarkdown(doc);
  expect(md).toContain('Left\n\n@[Today](cairn://date/2026-11-12)');
  expect(md).toContain('[Linked view: Tasks](cairn://page/db?view=v)');
  expect(docToPlainText(doc)).toContain('Today');
  const nested = markdownToDoc(
    '<details open><summary>Outer</summary>\n\n<details><summary>Inner</summary>\n\nText\n\n</details>\n\n</details>',
  );
  expect(nested.content?.[0].attrs?.open).toBe(true);
  expect(nested.content?.[0].content?.[1].content?.[0].type).toBe('details');
});
it('round trips page links and both mention kinds with escaped labels and table code pipes', () => {
  const atoms: DocNode[] = [
    { type: 'pageLink', attrs: { pageId: 'page', title: 'A [page] & more' } },
    { type: 'mention', attrs: { kind: 'user', id: 'user', label: 'Ada [team] & Co' } },
    { type: 'mention', attrs: { kind: 'date', id: '2026-11-12', label: 'Thursday' } },
  ];
  for (const atom of atoms) {
    const doc: DocNode = { type: 'doc', content: [{ type: 'paragraph', content: [atom] }] };
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  }
  const doc: DocNode = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'a|b', marks: [{ type: 'code' }] }] },
                  { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const parsed = markdownToDoc(docToMarkdown(doc));
  expect(parsed.content?.[0].content?.[1].content).toHaveLength(1);
  expect(docToPlainText(parsed)).toContain('a|b');
  expect(docToPlainText(parsed)).toContain('Second');
});

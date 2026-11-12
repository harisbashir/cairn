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
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('First'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Nested')] }] }] }, { type: 'listItem', content: [paragraph('Second')] }] },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('Three')] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('Done')] }, { type: 'taskItem', attrs: { checked: false }, content: [paragraph('Open')] }] },
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
    content.push({ type: 'text', text: 'website', marks: [{ type: 'link', attrs: { href: 'https://example.com/path' } }] }, { type: 'hardBreak' },
      { type: 'pageLink', attrs: { pageId: '1234567890123456', title: 'Related page' } });
    const source = doc({ type: 'paragraph', content });
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
  });
  it('parses ordinary Markdown and handles null and blank documents', () => {
    expect(markdownToDoc('# Hello\n\n- [x] done\n- [ ] waiting').content?.map(n => n.type)).toEqual(['heading', 'taskList']);
    expect(docToMarkdown(null)).toBe('');
    expect(markdownToDoc('')).toEqual(doc());
    expect(docToPlainText(null)).toBe('');
  });
  it('extracts readable plain text with no mark syntax', () => {
    const source = markdownToDoc('# Heading\n\nHello **world**  \nnext\n\n- first\n- second\n\n[Page](cairn://page/1234567890123456)');
    expect(docToPlainText(source)).toBe('Heading\nHello world\nnext\nfirst\nsecond\nPage');
  });
  it('preserves literal Markdown punctuation, entities, combined marks and marked whitespace', () => {
    const source = doc(paragraph('- item'), paragraph('1. number'), paragraph('&amp; &quot;'), {
      type: 'paragraph', content: [
        { type: 'text', text: ' hello ', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'highlight' }] },
        { type: 'pageLink', attrs: { pageId: '1234567890123456', title: 'A [b] *c* &amp;' } },
      ],
    });
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
  });
  it('preserves inline code containing backticks and HTML entities', () => {
    const source = doc({ type: 'paragraph', content: [{ type: 'text', text: '`<&`', marks: [{ type: 'code' }] }, text(' & < >')] });
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
  });
  it('preserves code combined with other marks regardless of input mark order', () => {
    for (const type of ['bold', 'italic', 'strike', 'highlight', 'link']) {
      const outer = { type, ...(type === 'link' ? { attrs: { href: 'https://example.com' } } : {}) };
      for (const marks of [[{ type: 'code' }, outer], [outer, { type: 'code' }]]) {
        const source = doc({ type: 'paragraph', content: [{ type: 'text', text: 'literal * <&', marks }] });
        const result = markdownToDoc(docToMarkdown(source));
        expect(result).toEqual(doc({ type: 'paragraph', content: [{ type: 'text', text: 'literal * <&', marks: [outer, { type: 'code' }] }] }));
      }
    }
  });
  it('preserves URL attributes with spaces, parentheses and existing percent escapes', () => {
    const href = 'https://example.com/a b(c)/already%20escaped?q=a&b=c';
    const source = doc({ type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }] }] },
      { type: 'image', attrs: { src: href, alt: 'Picture' } });
    expect(markdownToDoc(docToMarkdown(source))).toEqual(source);
    expect(markdownToDoc('[external](https://example.com/a%20b)').content?.[0].content?.[0].marks?.[0].attrs?.href).toBe('https://example.com/a%20b');
  });
});

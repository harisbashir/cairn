import { Marked } from 'marked';
import type { DocNode } from './types.ts';

type Mark = NonNullable<DocNode['marks']>[number];
type MdToken = {
  type: string;
  raw: string;
  text?: string;
  tokens?: MdToken[];
  depth?: number;
  lang?: string;
  href?: string;
  title?: string | null;
  ordered?: boolean;
  start?: number | '';
  items?: MdToken[];
  task?: boolean;
  checked?: boolean;
  escaped?: boolean;
  summary?: string;
  open?: boolean;
  kind?: string;
  id?: string;
  header?: { tokens: MdToken[]; text: string }[];
  rows?: { tokens: MdToken[]; text: string }[][];
};
const parser = new Marked({
  gfm: true,
  breaks: false,
  extensions: [
    {
      name: 'details',
      level: 'block',
      start: (source) => source.indexOf('<details'),
      tokenizer(source) {
        const opening = /^<details(?:\s+open(?:=["']?open["']?)?)?\s*>\s*<summary>([\s\S]*?)<\/summary>/.exec(source);
        if (!opening) return;
        let depth = 1;
        const tags = /<details\b[^>]*>|<\/details>/g;
        tags.lastIndex = opening[0].length;
        let tag: RegExpExecArray | null;
        while ((tag = tags.exec(source))) {
          depth += tag[0].startsWith('</') ? -1 : 1;
          if (!depth)
            return {
              type: 'details',
              raw: source.slice(0, tags.lastIndex),
              text: source.slice(opening[0].length, tag.index),
              summary: opening[1],
              open: /\sopen/.test(opening[0]),
            };
        }
      },
    },
    {
      name: 'mention',
      level: 'inline',
      start: (source) => source.indexOf('@['),
      tokenizer(source) {
        const match = /^@\[((?:\\.|[^\]])*)\]\((?:<)?cairn:\/\/(user|date)\/([^)>]+)>?\)/.exec(source);
        if (match) return { type: 'mention', raw: match[0], text: match[1], kind: match[2], id: match[3] };
      },
    },
    {
      name: 'highlight',
      level: 'inline',
      start: (source) => source.indexOf('=='),
      tokenizer(source) {
        const match = /^==(?=\S)([\s\S]*?\S)==/.exec(source);
        if (match)
          return { type: 'highlight', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
      },
    },
  ],
});
const escapeText = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]~<>#=+.!(){}|\-])/g, '\\$1');
const escapeLabel = (text: string) => escapeText(text).replace(/\n/g, ' ');
// Angle destinations preserve spaces, parentheses and existing percent escapes.
const destination = (text: string) => '<' + text.replace(/[\\<>]/g, (char) => '\\' + char) + '>';
const decode = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '\uFFFD';
    }
    return (
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? entity
    );
  });
function inline(node: DocNode): string {
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'mention')
    return `@[${escapeLabel(String(node.attrs?.label ?? ''))}](cairn://${String(node.attrs?.kind ?? 'user')}/${String(node.attrs?.id ?? '')})`;
  if (node.type === 'pageLink')
    return `[${escapeLabel(String(node.attrs?.title ?? ''))}](${destination('cairn://page/' + String(node.attrs?.pageId ?? ''))})`;
  if (node.type === 'image')
    return `![${escapeLabel(String(node.attrs?.alt ?? ''))}](${destination(String(node.attrs?.src ?? ''))})`;
  if (node.type !== 'text') return (node.content ?? []).map(inline).join('');
  let result = escapeText(node.text ?? '');
  if (node.marks?.length)
    result = result.replace(/^\s+|\s+$/g, (spaces) => [...spaces].map((char) => `&#${char.charCodeAt(0)};`).join(''));
  // Code must be the innermost mark: Markdown treats its contents literally.
  const marks = node.marks ?? [];
  const ordered = [
    ...marks.filter((mark) => mark.type === 'code'),
    ...marks.filter((mark) => mark.type !== 'code').reverse(),
  ];
  for (const mark of ordered) {
    switch (mark.type) {
      case 'code': {
        const raw = node.text ?? '';
        const fence = '`'.repeat(Math.max(0, ...(raw.match(/`+/g) ?? []).map((part) => part.length)) + 1);
        const pad = raw.startsWith('`') || raw.endsWith('`') || /^ .* $/.test(raw) ? ' ' : '';
        result = `${fence}${pad}${raw}${pad}${fence}`;
        break;
      }
      case 'bold':
        result = `**${result}**`;
        break;
      case 'italic':
        result = `_${result}_`;
        break;
      case 'strike':
        result = `~~${result}~~`;
        break;
      case 'highlight':
        result = `==${result}==`;
        break;
      case 'link':
        result = `[${result}](${destination(String(mark.attrs?.href ?? ''))})`;
        break;
    }
  }
  return result;
}
function blocks(nodes: DocNode[]): string {
  return nodes.map(block).join('\n\n');
}
function block(node: DocNode): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'doc':
      return blocks(children);
    case 'details': {
      const summary = children.find((child) => child.type === 'detailsSummary');
      const body = children.find((child) => child.type === 'detailsContent');
      return `<details${node.attrs?.open ? ' open' : ''}><summary>${(summary?.content ?? []).map(inline).join('')}</summary>\n\n${blocks(body?.content ?? [])}\n\n</details>`;
    }
    case 'detailsSummary':
      return children.map(inline).join('');
    case 'detailsContent':
    case 'columns':
    case 'column':
      return blocks(children);
    case 'table': {
      const rows = children.map(
        (row) =>
          '| ' +
          (row.content ?? [])
            .map((cell) =>
              (cell.content ?? [])
                .map(block)
                .join('<br>')
                .replace(/\n/g, '<br>')
                .replace(/\\.|[|]/g, (token) => (token === '|' ? '\\|' : token)),
            )
            .join(' | ') +
          ' |',
      );
      if (!rows.length) return '';
      rows.splice(1, 0, '| ' + (children[0].content ?? []).map(() => '---').join(' | ') + ' |');
      return rows.join('\n');
    }
    case 'databaseView':
      return `[Linked view${node.attrs?.title ? ': ' + escapeLabel(String(node.attrs.title)) : ''}](cairn://page/${String(node.attrs?.databaseId ?? '')}${node.attrs?.viewId ? '?view=' + encodeURIComponent(String(node.attrs.viewId)) : ''})`;
    case 'paragraph':
      return children.length ? children.map(inline).join('') : '<p></p>';
    case 'heading':
      return `${'#'.repeat(Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1))))} ${children.map(inline).join('')}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return children
        .map((item, index) => {
          const marker = node.type === 'orderedList' ? `${Number(node.attrs?.start ?? 1) + index}. ` : '- ';
          const check = node.type === 'taskList' ? `[${item.attrs?.checked ? 'x' : ' '}] ` : '';
          const body = blocks(item.content ?? []);
          return marker + check + body.replace(/\n/g, '\n' + ' '.repeat(marker.length));
        })
        .join('\n');
    case 'listItem':
    case 'taskItem':
      return blocks(children);
    case 'blockquote':
      return blocks(children)
        .split('\n')
        .map((line) => `>${line ? ' ' + line : ''}`)
        .join('\n');
    case 'callout':
      return `[!NOTE] ${String(node.attrs?.emoji ?? '💡')}\n\n${blocks(children)}`
        .split('\n')
        .map((line) => `>${line ? ' ' + line : ''}`)
        .join('\n');
    case 'codeBlock': {
      const body = children.map((child) => child.text ?? '').join('');
      const fence = '`'.repeat(Math.max(2, ...(body.match(/`+/g) ?? []).map((part) => part.length)) + 1);
      return `${fence}${String(node.attrs?.language ?? '')}\n${body}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    default:
      return inline(node);
  }
}
export function docToMarkdown(doc: DocNode | null): string {
  return doc ? block(doc) : '';
}

function textNode(text: string, marks: Mark[]): DocNode {
  return { type: 'text', text, ...(marks.length ? { marks } : {}) };
}
function inlines(tokens: MdToken[], marks: Mark[] = []): DocNode[] {
  return tokens
    .flatMap((token): DocNode[] => {
      const recurse = (mark: Mark) => inlines(token.tokens ?? [], [...marks, mark]);
      switch (token.type) {
        case 'mention':
          return [
            {
              type: 'mention',
              attrs: { kind: token.kind, id: token.id, label: decode((token.text ?? '').replace(/\\(.)/g, '$1')) },
            },
          ];
        case 'html':
          return /^<br\s*\/?>$/i.test(token.raw) ? [{ type: 'hardBreak' }] : [textNode(token.raw, marks)];
        case 'strong':
          return recurse({ type: 'bold' });
        case 'em':
          return recurse({ type: 'italic' });
        case 'del':
          return recurse({ type: 'strike' });
        case 'highlight':
          return recurse({ type: 'highlight' });
        case 'codespan':
          return [textNode(token.text ?? '', [...marks, { type: 'code' }])];
        case 'link': {
          if (token.href?.startsWith('cairn://page/'))
            return [
              {
                type: 'pageLink',
                attrs: {
                  pageId: token.href.slice(13),
                  title: token.tokens ? inlines(token.tokens).map(docToPlainText).join('') : decode(token.text ?? ''),
                },
              },
            ];
          return recurse({ type: 'link', attrs: { href: token.href ?? '' } });
        }
        case 'image':
          return [
            {
              type: 'image',
              attrs: {
                src: token.href ?? '',
                alt: decode((token.text ?? '').replace(/\\([\\`*_[\]~<>#=+.!(){}|\-])/g, '$1')),
              },
            },
          ];
        case 'br':
          return [{ type: 'hardBreak' }];
        case 'escape':
          return [textNode(token.text ?? '', marks)];
        case 'text':
          return token.tokens ? inlines(token.tokens, marks) : token.text ? [textNode(decode(token.text), marks)] : [];
        default:
          return token.raw ? [textNode(decode(token.raw), marks)] : [];
      }
    })
    .reduce<DocNode[]>((result, node) => {
      const last = result.at(-1);
      if (last?.type === 'text' && node.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(node.marks))
        last.text = (last.text ?? '') + node.text;
      else result.push(node);
      return result;
    }, []);
}
const lex = (source: string): MdToken[] => parser.lexer(source) as unknown as MdToken[];
function parseBlocks(tokens: MdToken[]): DocNode[] {
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'space':
        return [];
      case 'details':
        return [
          {
            type: 'details',
            attrs: { open: !!token.open },
            content: [
              { type: 'detailsSummary', content: inlines(lex(token.summary ?? '')[0]?.tokens ?? []) },
              { type: 'detailsContent', content: parseBlocks(lex((token.text ?? '').trim())) },
            ],
          },
        ];
      case 'table':
        return [
          {
            type: 'table',
            content: [token.header ?? [], ...(token.rows ?? [])].map((row, index) => ({
              type: 'tableRow',
              content: row.map((cell) => ({
                type: index ? 'tableCell' : 'tableHeader',
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                content: [{ type: 'paragraph', content: inlines(cell.tokens) }],
              })),
            })),
          },
        ];
      case 'heading':
        return [
          { type: 'heading', attrs: { level: Math.min(3, token.depth ?? 1) }, content: inlines(token.tokens ?? []) },
        ];
      case 'paragraph':
      case 'text': {
        const children = inlines(token.tokens ?? [{ ...token, type: 'text', tokens: undefined }]);
        // Tiptap images are blocks, while marked lexes them inside paragraphs.
        const result: DocNode[] = [];
        let paragraph: DocNode[] = [];
        for (const child of children) {
          if (child.type === 'image') {
            if (paragraph.length) result.push({ type: 'paragraph', content: paragraph });
            paragraph = [];
            result.push(child);
          } else paragraph.push(child);
        }
        if (paragraph.length || !result.length) result.push({ type: 'paragraph', content: paragraph });
        return result;
      }
      case 'code':
        return [
          {
            type: 'codeBlock',
            attrs: { language: token.lang ?? '' },
            ...(token.text ? { content: [{ type: 'text', text: token.text }] } : { content: [] }),
          },
        ];
      case 'hr':
        return [{ type: 'horizontalRule' }];
      case 'blockquote': {
        const callout = /^\[!NOTE\][ \t]*([^\n]*)\n?/.exec(token.text ?? '');
        if (callout)
          return [
            {
              type: 'callout',
              attrs: { emoji: callout[1].trim() || '💡' },
              content: parseBlocks(lex((token.text ?? '').slice(callout[0].length).replace(/^\n/, ''))),
            },
          ];
        return [{ type: 'blockquote', content: parseBlocks(token.tokens ?? []) }];
      }
      case 'list': {
        const items = token.items ?? [];
        // Mixed task and ordinary lists are represented as adjacent Tiptap lists.
        const groups: DocNode[] = [];
        for (const item of items) {
          const type = item.task ? 'taskList' : token.ordered ? 'orderedList' : 'bulletList';
          let list = groups.at(-1);
          if (list?.type !== type) {
            list = {
              type,
              ...(type === 'orderedList' && token.start && token.start !== 1 ? { attrs: { start: token.start } } : {}),
              content: [],
            };
            groups.push(list);
          }
          list.content!.push({
            type: item.task ? 'taskItem' : 'listItem',
            ...(item.task ? { attrs: { checked: !!item.checked } } : {}),
            content: parseBlocks(item.tokens ?? []),
          });
        }
        return groups;
      }
      case 'html':
        return /^<p><\/p>\s*$/.test(token.raw)
          ? [{ type: 'paragraph', content: [] }]
          : [{ type: 'paragraph', content: [textNode(token.raw.trim(), [])] }];
      default:
        return token.text ? [{ type: 'paragraph', content: [textNode(decode(token.text), [])] }] : [];
    }
  });
}
export function markdownToDoc(markdown: string): DocNode {
  return { type: 'doc', content: parseBlocks(lex(markdown)) };
}
export function docToPlainText(doc: DocNode | null): string {
  if (!doc) return '';
  if (doc.type === 'text') return doc.text ?? '';
  if (doc.type === 'pageLink') return String(doc.attrs?.title ?? '');
  if (doc.type === 'mention') return String(doc.attrs?.label ?? '');
  if (doc.type === 'databaseView') return String(doc.attrs?.title ?? '');
  if (doc.type === 'image') return String(doc.attrs?.alt ?? '');
  if (doc.type === 'hardBreak') return '\n';
  const children = doc.content ?? [];
  const separator = ['paragraph', 'heading'].includes(doc.type) ? '' : '\n';
  return children.map(docToPlainText).join(separator);
}

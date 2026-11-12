import { Extension, mergeAttributes, Node, type Editor as TEditor, type Range } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { Placeholder } from '@tiptap/extensions';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import {
  Bold, Code, Code2, Heading1, Heading2, Heading3, Highlighter, ImageIcon, Italic, Lightbulb, Link2, List, ListChecks,
  ListOrdered, Minus, Pilcrow, Quote, Strikethrough, FileText,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocNode, TreeNode } from '../../shared/types.ts';
import { post } from './api.ts';

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { emoji: { default: '💡', parseHTML: (el) => el.getAttribute('data-emoji') ?? '💡', renderHTML: (a) => ({ 'data-emoji': a.emoji }) } };
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'callout', 'data-callout': '' }),
      ['span', { class: 'callout-emoji emoji', contenteditable: 'false' }, node.attrs.emoji],
      ['div', { class: 'callout-body' }, 0]];
  },
});

export const PageLink = Node.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      pageId: { default: '', parseHTML: (el) => el.getAttribute('data-page-id'), renderHTML: (a) => ({ 'data-page-id': a.pageId }) },
      title: { default: 'Untitled', parseHTML: (el) => el.textContent, renderHTML: () => ({}) },
    };
  },
  parseHTML() { return [{ tag: 'a[data-page-id]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ['a', mergeAttributes(HTMLAttributes, { class: 'page-link' }), node.attrs.title || 'Untitled'];
  },
});

interface Item { id: string; title: string; desc?: string; icon: ReactNode; run: (editor: TEditor, range: Range) => void }
interface MenuState { kind: 'slash' | 'page'; items: Item[]; index: number; rect: DOMRect | null; pick: (item: Item) => void }
interface Bridge { set: (updater: (prev: MenuState | null) => MenuState | null) => void; items: (kind: 'slash' | 'page', query: string) => Item[] }

function suggest(kind: 'slash' | 'page', char: string, bridge: { current: Bridge }) {
  return Extension.create({
    name: `suggest-${kind}`,
    addProseMirrorPlugins() {
      return [Suggestion<Item>({
        editor: this.editor,
        char,
        pluginKey: new PluginKey(`suggest-${kind}`),
        allowSpaces: kind === 'page',
        items: ({ query }) => bridge.current.items(kind, query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          const show = (p: SuggestionProps<Item>) => bridge.current.set((prev) => ({
            kind, items: p.items, index: Math.min(prev?.index ?? 0, Math.max(p.items.length - 1, 0)), rect: p.clientRect?.() ?? null, pick: (it) => p.command(it),
          }));
          return {
            onStart: (p) => { bridge.current.set(() => null); show(p); },
            onUpdate: show,
            onExit: () => bridge.current.set(() => null),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              if (event.key === 'Escape') { bridge.current.set(() => null); return true; }
              let handled = false;
              bridge.current.set((prev) => {
                if (!prev || !prev.items.length) return prev;
                if (event.key === 'ArrowDown') { handled = true; return { ...prev, index: (prev.index + 1) % prev.items.length }; }
                if (event.key === 'ArrowUp') { handled = true; return { ...prev, index: (prev.index - 1 + prev.items.length) % prev.items.length }; }
                if (event.key === 'Enter' || event.key === 'Tab') { handled = true; queueMicrotask(() => prev.pick(prev.items[prev.index])); }
                return prev;
              });
              return handled;
            },
          };
        },
      })];
    },
  });
}

async function uploadImage(wid: string, file: File): Promise<string | null> {
  const fd = new FormData(); fd.append('file', file, file.name || 'pasted-image.png');
  try { return (await post<{ url: string }>(`/api/workspaces/${wid}/files`, fd)).url; } catch { return null; }
}

/** Uploads pasted or dropped images (screenshots included) and inserts them where the cursor is. */
function insertImages(editor: TEditor, wid: string, files: File[], pos?: number): boolean {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!images.length) return false;
  void (async () => {
    for (const file of images) {
      const url = await uploadImage(wid, file);
      if (!url) { window.dispatchEvent(new CustomEvent('cairn:toast', { detail: 'That image couldn’t be uploaded.' })); continue; }
      if (pos !== undefined) editor.chain().focus().insertContentAt(pos, { type: 'image', attrs: { src: url } }).run();
      else editor.chain().focus().setImage({ src: url }).run();
    }
  })();
  return true;
}

function pickImage(wid: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await uploadImage(wid, file) : null);
    };
    input.click();
  });
}

function slashItems(wid: string): Item[] {
  const block = (id: string, title: string, desc: string, icon: ReactNode, fn: (c: ReturnType<TEditor['chain']>) => ReturnType<TEditor['chain']>): Item => ({
    id, title, desc, icon, run: (editor, range) => { fn(editor.chain().focus().deleteRange(range)).run(); },
  });
  return [
    block('text', 'Text', 'Plain paragraph', <Pilcrow size={17} />, (c) => c.setParagraph()),
    block('h1', 'Heading 1', 'Large section heading', <Heading1 size={17} />, (c) => c.setHeading({ level: 1 })),
    block('h2', 'Heading 2', 'Medium section heading', <Heading2 size={17} />, (c) => c.setHeading({ level: 2 })),
    block('h3', 'Heading 3', 'Small section heading', <Heading3 size={17} />, (c) => c.setHeading({ level: 3 })),
    block('todo', 'To-do list', 'Track tasks with checkboxes', <ListChecks size={17} />, (c) => c.toggleTaskList()),
    block('bullet', 'Bulleted list', 'A simple list', <List size={17} />, (c) => c.toggleBulletList()),
    block('number', 'Numbered list', 'A list with numbering', <ListOrdered size={17} />, (c) => c.toggleOrderedList()),
    block('quote', 'Quote', 'Capture a quotation', <Quote size={17} />, (c) => c.setBlockquote()),
    block('callout', 'Callout', 'Make text stand out', <Lightbulb size={17} />, (c) => c.insertContent({ type: 'callout', content: [{ type: 'paragraph' }] })),
    block('code', 'Code', 'A block of code', <Code2 size={17} />, (c) => c.setCodeBlock()),
    block('divider', 'Divider', 'Separate sections', <Minus size={17} />, (c) => c.setHorizontalRule()),
    {
      id: 'image', title: 'Image', desc: 'Upload a picture', icon: <ImageIcon size={17} />,
      run: (editor, range) => {
        editor.chain().focus().deleteRange(range).run();
        pickImage(wid).then((url) => { if (url) editor.chain().focus().setImage({ src: url }).run(); });
      },
    },
  ];
}

export function Editor({ wid, content, version, editable, pages, onChange }: {
  wid: string;
  content: DocNode | null;
  version: string; // changes when the server copy changes
  editable: boolean;
  pages: TreeNode[];
  onChange: (doc: DocNode) => void;
}) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const dirty = useRef(false);
  const touched = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const bridge = useRef<Bridge>(null!);
  bridge.current = {
    set: setMenu,
    items: (kind, query) => {
      const q = query.toLowerCase();
      if (kind === 'slash') return slashItems(wid).filter((i) => i.title.toLowerCase().includes(q) || i.id.includes(q));
      return pagesRef.current.filter((p) => (p.title || 'Untitled').toLowerCase().includes(q)).slice(0, 8).map((p) => ({
        id: p.id, title: p.title || 'Untitled', icon: p.icon ? <span className="emoji">{p.icon}</span> : <FileText size={16} />,
        run: (editor, range) => { editor.chain().focus().insertContentAt(range, [{ type: 'pageLink', attrs: { pageId: p.id, title: p.title || 'Untitled' } }, { type: 'text', text: ' ' }]).run(); },
      }));
    },
  };

  const extensions = useMemo(() => [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
    TaskList, TaskItem.configure({ nested: true }), Highlight, Image, Callout, PageLink,
    Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : 'Write something, type / for blocks, or @ to link a page') }),
    suggest('slash', '/', bridge), suggest('page', '@', bridge),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const editor = useEditor({
    extensions,
    content: content ?? undefined,
    editable,
    editorProps: {
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || !editorRef.current) return false;
        touched.current = true;
        return insertImages(editorRef.current, wid, files);
      },
      handleDrop: (view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (!files.length || !editorRef.current) return false;
        touched.current = true;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
        const handled = insertImages(editorRef.current, wid, files, at);
        if (handled) event.preventDefault();
        return handled;
      },
    },
    // Ignore the editor's own normalisation on load; only save after the person has touched the page.
    onUpdate: ({ editor }) => { if (!touched.current) return; dirty.current = true; onChangeRef.current(editor.getJSON() as DocNode); },
  });

  const editorRef = useRef<TEditor | null>(null);
  editorRef.current = editor;

  // Adopt the server copy when someone else (or an AI agent) changed the page and we have nothing unsaved.
  const seen = useRef(version);
  useEffect(() => {
    if (!editor || version === seen.current) return;
    seen.current = version;
    if (dirty.current) return;
    editor.commands.setContent(content ?? { type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false });
  }, [version, content, editor]);
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);

  // Parent tells us when a save has landed.
  useEffect(() => {
    const saved = () => { dirty.current = false; };
    window.addEventListener('cairn:saved', saved);
    return () => window.removeEventListener('cairn:saved', saved);
  }, []);

  if (!editor) return null;
  const mark = (name: string, label: string, icon: ReactNode, run: () => void) => (
    <button type="button" aria-label={label} title={label} className={editor.isActive(name) ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); run(); }}>{icon}</button>
  );

  return (
    <div
      onPointerDownCapture={() => { touched.current = true; }}
      onKeyDownCapture={() => { touched.current = true; }}
      onPasteCapture={() => { touched.current = true; }}
      onDropCapture={() => { touched.current = true; }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        const pageId = a.getAttribute('data-page-id');
        if (pageId) { e.preventDefault(); navigate(`/w/${wid}/p/${pageId}`); return; }
        const href = a.getAttribute('href');
        if (href && (e.metaKey || e.ctrlKey || !editable)) { e.preventDefault(); window.open(href, '_blank', 'noopener'); }
      }}
    >
      {editable && (
        <BubbleMenu editor={editor} shouldShow={({ editor, state }) => !state.selection.empty && !editor.isActive('codeBlock') && !editor.isActive('image')}>
          {linking !== null ? (
            <form className="bubble" onSubmit={(e) => {
              e.preventDefault();
              const href = linking.trim();
              if (href) editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z]+:|^\//i.test(href) ? href : `https://${href}` }).run();
              else editor.chain().focus().unsetLink().run();
              setLinking(null);
            }}>
              <input className="input small" style={{ width: 240 }} autoFocus placeholder="Paste a link, or leave empty to remove" value={linking}
                onChange={(e) => setLinking(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setLinking(null); }} />
            </form>
          ) : (
            <div className="bubble">
              {mark('bold', 'Bold', <Bold size={16} />, () => editor.chain().focus().toggleBold().run())}
              {mark('italic', 'Italic', <Italic size={16} />, () => editor.chain().focus().toggleItalic().run())}
              {mark('strike', 'Strikethrough', <Strikethrough size={16} />, () => editor.chain().focus().toggleStrike().run())}
              {mark('code', 'Inline code', <Code size={16} />, () => editor.chain().focus().toggleCode().run())}
              {mark('highlight', 'Highlight', <Highlighter size={16} />, () => editor.chain().focus().toggleHighlight().run())}
              {mark('link', 'Link', <Link2 size={16} />, () => setLinking(editor.getAttributes('link').href ?? ''))}
            </div>
          )}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {menu && menu.rect && menu.items.length > 0 && (
        <div className={`menu ${menu.kind === 'slash' ? 'slash' : ''}`} style={{ position: 'fixed', left: Math.min(menu.rect.left, window.innerWidth - 310), ...(menu.rect.bottom + 330 > window.innerHeight ? { bottom: window.innerHeight - menu.rect.top + 6 } : { top: menu.rect.bottom + 6 }), maxHeight: 320 }}>
          <div className="menu-label">{menu.kind === 'slash' ? 'Blocks' : 'Link to page'}</div>
          {menu.items.map((it, i) => (
            <button key={it.id} type="button" className={`menu-item${i === menu.index ? ' active' : ''}`} ref={(el) => { if (el && i === menu.index) el.scrollIntoView({ block: 'nearest' }); }}
              onMouseDown={(e) => { e.preventDefault(); menu.pick(it); }}>
              {menu.kind === 'slash' ? <span className="ico">{it.icon}</span> : it.icon}
              <span className="grow"><div>{it.title}</div>{it.desc && <div className="d">{it.desc}</div>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

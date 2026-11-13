import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../ui.tsx';
import { searchMentionables, type Mentionables } from './hooks.ts';

const MENTION = /@\[([^\]]*)\]\(cairn:\/\/(user|date|page)\/([^)\s]+)\)/g;

/** Comment and notification text with mentions shown as name pills. */
export function MentionText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span key={m.index} className={`inb-mention${m[2] === 'user' ? '' : ' plain'}`}>{m[2] === 'user' ? '@' : ''}{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Plain text for one-line previews: "@[Haris](cairn://user/x)" becomes "@Haris". */
export const mentionsToPlain = (text: string) => text.replace(MENTION, (_m, name: string, kind: string) => (kind === 'user' ? `@${name}` : name));

/**
 * A comment draft. People are written as "@Name" while typing; the names picked from the menu are remembered so
 * the text can be turned into mention markup when it's sent.
 */
export function useMentionDraft(initialBody = '') {
  const names = useRef(new Map<string, string>());
  const [text, setText] = useState(() => fromBody(initialBody, names.current));
  return {
    text, setText, names: names.current,
    reset: (body = '') => { names.current.clear(); setText(fromBody(body, names.current)); },
    toBody: () => toBody(text, names.current),
  };
}
export type MentionDraft = ReturnType<typeof useMentionDraft>;

function fromBody(body: string, names: Map<string, string>) {
  return body.replace(MENTION, (_m, name: string, kind: string, id: string) => {
    if (kind !== 'user') return name;
    names.set(name, id);
    return `@${name}`;
  });
}

function toBody(text: string, names: Map<string, string>) {
  let out = text;
  // Longest names first so "Sara Lind" wins over "Sara".
  for (const [name, id] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[\\s(])@${esc}(?![\\w])`, 'g'), `$1@[${name}](cairn://user/${id})`);
  }
  return out.trim();
}

/** A growing textarea that suggests people after "@". Enter sends (Shift+Enter for a new line) unless `multiline`. */
export function MentionInput({
  wid, draft, onSubmit, placeholder, autoFocus, label, onCancel,
}: {
  wid: string; draft: MentionDraft; onSubmit: () => void; placeholder: string; autoFocus?: boolean; label: string; onCancel?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [people, setPeople] = useState<Mentionables['people']>([]);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = '0'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }
  }, [draft.text]);
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus]);

  useEffect(() => {
    if (query === null) { setPeople([]); return; }
    let live = true;
    const t = setTimeout(() => searchMentionables(wid, query).then((r) => { if (live) { setPeople(r.people.slice(0, 6)); setActive(0); } }).catch(() => {}), 100);
    return () => { live = false; clearTimeout(t); };
  }, [query, wid]);

  const detect = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart ?? 0);
    const m = /(^|[\s(])@([^\s@]{0,30})$/.exec(before);
    setQuery(m ? m[2] : null);
  };

  const pick = (p: Mentionables['people'][number]) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${p.name} `);
    const next = before + el.value.slice(caret);
    draft.names.set(p.name, p.id);
    draft.setText(next);
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const open = query !== null && people.length > 0;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + people.length) % people.length);
      return;
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); pick(people[active]); return; }
    if (e.key === 'Escape') {
      if (query !== null) { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
      if (onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      if (draft.text.trim()) onSubmit();
    }
  };

  const open = query !== null && people.length > 0;
  return (
    <div className="inb-input-wrap">
      <textarea
        ref={ref} className="input inb-input" rows={1} value={draft.text} placeholder={placeholder} aria-label={label}
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        onChange={(e) => { draft.setText(e.target.value); detect(e.target); }}
        onKeyDown={onKey} onClick={(e) => detect(e.currentTarget)} onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {open && (
        <div className="inb-suggest" id={listId} role="listbox" aria-label="People">
          {people.map((p, i) => (
            <button
              key={p.id} type="button" role="option" aria-selected={i === active} className={`inb-suggest-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => pick(p)}
            >
              <Avatar name={p.name} color={p.color} /><span className="grow">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

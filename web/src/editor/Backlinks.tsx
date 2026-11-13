// "Linked from": pages that link or mention this page, and rows that point at it through a relation.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Backlink } from '../../../shared/types.ts';
import { get, qc } from '../api.ts';
import { PageIcon, useShell } from '../Shell.tsx';

const FOLD = 5;

export function Backlinks({ pageId }: { pageId: string }) {
  const s = useShell();
  const q = useQuery({ queryKey: ['backlinks', pageId], queryFn: () => get<Backlink[]>(`/api/pages/${pageId}/backlinks`) });
  // Links live on other pages: refresh when any page in the workspace changes.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => { clearTimeout(t); t = setTimeout(() => qc.invalidateQueries({ queryKey: ['backlinks', pageId] }), 800); };
    window.addEventListener('cairn:remote', on);
    return () => { clearTimeout(t); window.removeEventListener('cairn:remote', on); };
  }, [pageId]);
  const list = q.data ?? [];
  if (!list.length) return null;

  // Mentions and links first, as one group; relation rows grouped by their database.
  const groups = new Map<string, Backlink[]>();
  for (const b of list) {
    const key = b.via === 'relation' ? `rel:${b.path || b.snippet}` : 'pages';
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === 'pages' ? -1 : b === 'pages' ? 1 : a.localeCompare(b)));

  return (
    <section className="backlinks" aria-label="Linked from">
      <h2 className="bl-head">Linked from <span className="bl-count">{list.length}</span></h2>
      {ordered.map(([key, items]) => (
        <Group key={key} label={key === 'pages' ? (ordered.length > 1 ? 'Pages' : '') : key.slice(4)} items={items} wid={s.wid} />
      ))}
    </section>
  );
}

function Group({ label, items, wid }: { label: string; items: Backlink[]; wid: string }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, FOLD);
  return (
    <div className="bl-group">
      {label && <div className="bl-label">{label}</div>}
      {shown.map((b) => (
        <Link key={b.id} className="bl-item" to={`/w/${wid}/p/${b.id}`}>
          <span className="bl-icon"><PageIcon icon={b.icon} kind={b.kind} size={16} /></span>
          <span className="bl-text">
            <span className="bl-title">{b.title || 'Untitled'}{b.via !== 'relation' && b.path && <span className="bl-path">{b.path}</span>}</span>
            {b.via !== 'relation' && b.snippet && <span className="bl-snippet">{b.snippet}</span>}
          </span>
        </Link>
      ))}
      {items.length > FOLD && (
        <button type="button" className="bl-fold" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show ${items.length - FOLD} more`}</button>
      )}
    </div>
  );
}

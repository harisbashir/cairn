import { ArrowUpRight, FileText, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageIcon, useShell } from '../../Shell.tsx';
import { Popover } from '../../ui.tsx';
import type { WidgetProps } from '../types.ts';
import { WidgetMessage } from './kit.tsx';

interface QuickLink { label: string; url: string }

function readLinks(v: unknown): QuickLink[] {
  if (!Array.isArray(v)) return [];
  return v.filter((l): l is QuickLink => !!l && typeof l === 'object' && typeof l.url === 'string')
    .map((l) => ({ label: typeof l.label === 'string' ? l.label : '', url: l.url }));
}

/** Adds https:// to bare addresses like "example.com"; leaves app paths and other schemes alone. */
function normalise(url: string) {
  const u = url.trim();
  if (!u || u.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return `https://${u}`;
}

const pageIdOf = (url: string, wid: string) => url.match(new RegExp(`^/w/${wid}/p/([^/?#]+)$`))?.[1];

export function LinksWidget({ widget, editing, onChange }: WidgetProps) {
  const s = useShell();
  const links = readLinks(widget.config.links);
  const nodes = s.tree?.nodes ?? [];
  const set = (next: QuickLink[]) => onChange({ ...widget.config, links: next });

  if (editing) {
    return (
      <div className="hm-links-edit">
        {links.map((l, i) => (
          <div key={i} className="hm-link-row">
            <input className="input small" aria-label={`Link ${i + 1} label`} placeholder="Label" value={l.label}
              onChange={(e) => set(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input className="input small" aria-label={`Link ${i + 1} address`} placeholder="https://…" value={l.url}
              onChange={(e) => set(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
              onBlur={(e) => set(links.map((x, j) => (j === i ? { ...x, url: normalise(e.target.value) } : x)))} />
            <button type="button" className="icon-btn" aria-label={`Remove link ${l.label || i + 1}`} title="Remove link"
              onClick={() => set(links.filter((_, j) => j !== i))}><X size={15} /></button>
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn small" onClick={() => set([...links, { label: '', url: '' }])}><Plus size={14} />Add Link</button>
          <PagePicker onPick={(id, title) => set([...links, { label: title, url: `/w/${s.wid}/p/${id}` }])} />
        </div>
      </div>
    );
  }

  const shown = links.filter((l) => l.url);
  if (shown.length === 0) return <WidgetMessage>No links yet. Select Customize to add some.</WidgetMessage>;
  return (
    <div className="hm-links">
      {shown.map((l, i) => {
        const pid = pageIdOf(l.url, s.wid);
        if (pid || l.url.startsWith('/')) {
          const node = pid ? nodes.find((n) => n.id === pid) : undefined;
          return (
            <Link key={i} className="btn hm-link" to={l.url}>
              {node ? <PageIcon icon={node.icon} kind={node.kind} /> : <FileText size={15} aria-hidden />}
              <span className="hm-ellipsis">{l.label || node?.title || 'Untitled'}</span>
            </Link>
          );
        }
        let host = l.url;
        try { host = new URL(l.url).host; } catch { /* keep the raw address as the fallback label */ }
        return (
          <a key={i} className="btn hm-link" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
            <span className="hm-ellipsis">{l.label || host}</span>
            <ArrowUpRight size={15} aria-label="(opens in a new tab)" />
          </a>
        );
      })}
    </div>
  );
}

function PagePicker({ onPick }: { onPick: (id: string, title: string) => void }) {
  const s = useShell();
  const [q, setQ] = useState('');
  const matches = (s.tree?.nodes ?? [])
    .filter((n) => (n.title || 'Untitled').toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 30);
  return (
    <Popover
      onOpenChange={(open) => { if (!open) setQ(''); }}
      trigger={(props) => <button type="button" className="btn small" {...props}><FileText size={14} />Link a Page</button>}
    >
      {(close) => (
        <>
          <div className="menu-pad">
            <input className="input small" autoFocus placeholder="Find a page…" aria-label="Find a page" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {matches.length === 0 && <div className="menu-label">No matching pages</div>}
          {matches.map((n) => (
            <button key={n.id} type="button" className="menu-item" onClick={() => { onPick(n.id, n.title || 'Untitled'); close(); }}>
              <PageIcon icon={n.icon} kind={n.kind} />
              <span className="grow">{n.title || 'Untitled'}</span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

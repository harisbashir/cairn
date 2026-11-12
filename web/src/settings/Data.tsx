import { Database, Download, FileText, Search, Send, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { Job, NotionSource, TreeNode } from '../../../shared/types.ts';
import { api, post } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { JobProgress } from './common.tsx';

const ACCEPT = '.md,.markdown,.txt,.csv,.json,.zip';

export function DataSection({ onClose }: { onClose: () => void }) {
  const s = useShell();
  const canEdit = s.workspace.role !== 'viewer';
  return (
    <>
      <h2>Import & Export</h2>
      <p className="muted">Bring pages into {s.workspace.name} or take a full copy with you. Your data is never locked in.</p>
      {canEdit && <FileImport onClose={onClose} />}
      {canEdit && <NotionImport onClose={onClose} />}
      <WorkspaceExport />
      {canEdit && <NotionExport onClose={onClose} />}
      {!canEdit && <p className="subtle st-help">Viewers can export. Ask an owner or admin for edit access to import pages.</p>}
    </>
  );
}

function FileImport({ onClose }: { onClose: () => void }) {
  const s = useShell();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    if (!/\.(md|markdown|txt|csv|json|zip)$/i.test(f.name)) { setError(`Cairn can’t import “${f.name}”. Choose a .md, .csv, .json or .zip file.`); return; }
    setFile(f); setError(''); setJobId(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const job = await api<Job>('POST', `/api/workspaces/${s.wid}/import`, fd);
      setJobId(job.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) upload(f);
  };
  return (
    <>
      <h3>Import from files</h3>
      <section>
        <div
          className={`st-drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Upload size={22} aria-hidden />
          <b>Drop a file here</b>
          <span className="subtle">or</span>
          <button className="btn" disabled={busy} onClick={() => input.current?.click()}>Choose File…</button>
          <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        </div>
        <ul className="st-kinds">
          <li><b>Markdown</b> (.md) becomes a page.</li>
          <li><b>CSV</b> (.csv) becomes a database, with column types worked out for you.</li>
          <li><b>Notion export</b> (.zip): in Notion choose Export, then “Markdown & CSV”, and import the zip as it is.</li>
          <li><b>Cairn export</b> (.zip or .json) restores pages exactly as they were.</li>
        </ul>
        {busy && <p className="subtle" role="status">Uploading {file?.name}…</p>}
        {error && <p className="err" role="alert">{error}</p>}
        {jobId && <JobProgress key={jobId} id={jobId} onOpen={onClose} />}
      </section>
    </>
  );
}

function NotionImport({ onClose }: { onClose: () => void }) {
  const s = useShell();
  const [token, setToken] = useState('');
  const [sources, setSources] = useState<NotionSource[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const find = async () => {
    setBusy(true); setError(''); setJobId(null);
    try {
      const list = await post<NotionSource[]>(`/api/workspaces/${s.wid}/notion/sources`, { token: token.trim() });
      setSources(list); setPicked(new Set());
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setError('');
    try {
      const job = await post<Job>(`/api/workspaces/${s.wid}/notion/import`, { token: token.trim(), sourceIds: [...picked] });
      setJobId(job.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const all = !!sources?.length && picked.size === sources.length;
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <h3>Import from Notion</h3>
      <section>
        <ol className="st-steps">
          <li>Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">notion.so/my-integrations</a> and create an internal integration. Read access is enough.</li>
          <li>In Notion, open each page or database you want to copy, choose <b>•••</b> → <b>Connections</b>, and add your integration.</li>
          <li>Copy the integration’s secret and paste it here.</li>
        </ol>
        <form className="row st-wrap st-end" onSubmit={(e) => { e.preventDefault(); find(); }}>
          <label className="field grow"><span>Notion integration secret</span>
            <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder="ntn_…" value={token} onChange={(e) => { setToken(e.target.value); setSources(null); }} />
          </label>
          <button className="btn" disabled={!token.trim() || busy}><Search size={15} />Find My Notion Content</button>
        </form>
        <span className="subtle">Cairn uses the secret only for this import and never stores it. Notion is only read, never changed.</span>
        {sources && sources.length === 0 && <p className="muted">Notion didn’t share anything with this integration yet. Add it to a page or database under Connections, then try again.</p>}
        {sources && sources.length > 0 && (
          <div className="st-checklist">
            <label className="st-check-row st-check-all">
              <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(sources.map((x) => x.id)))} />
              <b>Select All</b><span className="subtle">{picked.size} of {sources.length} selected</span>
            </label>
            <div className="st-check-list">
              {sources.map((src) => (
                <label key={src.id} className="st-check-row">
                  <input type="checkbox" checked={picked.has(src.id)} onChange={() => toggle(src.id)} />
                  <span className="st-src-icon emoji" aria-hidden>{src.icon || (src.kind === 'database' ? <Database size={15} /> : <FileText size={15} />)}</span>
                  <span className="grow st-ellipsis">{src.title || 'Untitled'}</span>
                  <span className="subtle">{src.kind === 'database' ? 'Database' : 'Page'}</span>
                </label>
              ))}
            </div>
            <div className="row"><button className="btn primary" disabled={!picked.size || busy || !!jobId} onClick={start}>Import Selected</button></div>
          </div>
        )}
        {error && <p className="err" role="alert">{error}</p>}
        {jobId && <JobProgress key={jobId} id={jobId} onOpen={onClose} onFinish={() => setToken('')} />}
      </section>
    </>
  );
}

function WorkspaceExport() {
  const s = useShell();
  return (
    <>
      <h3>Export this workspace</h3>
      <section>
        <p className="muted">One zip with every page you can see: pages as Markdown, databases as CSV, uploaded images and files, and a full-fidelity <code className="st-code">cairn.json</code> that you can import again into any Cairn server.</p>
        <div className="row"><a className="btn" href={`/api/workspaces/${s.wid}/export`} download><Download size={15} />Download Workspace (.zip)</a></div>
      </section>
    </>
  );
}

/** Pulls a Notion page id out of a pasted URL or id. */
function notionPageId(input: string): string | null {
  const text = input.trim();
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0].replace(/-/g, '').toLowerCase();
  const hex = text.split(/[?#]/)[0].match(/[0-9a-f]{32}(?![0-9a-f])/gi);
  return hex ? hex[hex.length - 1].toLowerCase() : null;
}

function flatten(nodes: TreeNode[]): { node: TreeNode; depth: number }[] {
  const kids = new Map<string | null, TreeNode[]>();
  for (const n of nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const out: { node: TreeNode; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of (kids.get(parent) ?? []).sort((a, b) => a.position - b.position)) { out.push({ node: n, depth }); walk(n.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

function NotionExport({ onClose }: { onClose: () => void }) {
  const s = useShell();
  const options = useMemo(() => flatten(s.tree?.nodes ?? []), [s.tree]);
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');
  const [parent, setParent] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const parentId = notionPageId(parent);
  const send = async () => {
    if (!parentId) return;
    setBusy(true); setError(''); setJobId(null);
    try {
      const job = await post<Job>(`/api/workspaces/${s.wid}/notion/export`, { token: token.trim(), pageId, notionParentPageId: parentId });
      setJobId(job.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <h3>Export to Notion</h3>
      <section>
        <p className="muted">Copies a page with its sub-pages, or a database with its rows, into Notion under a page you choose. The integration needs to be connected to that Notion page.</p>
        <label className="field"><span>Cairn page or database</span>
          <select className="select" value={pageId} onChange={(e) => setPageId(e.target.value)}>
            <option value="">Choose…</option>
            {options.map(({ node, depth }) => (
              <option key={node.id} value={node.id}>{' '.repeat(depth)}{node.icon ? `${node.icon} ` : ''}{node.title || 'Untitled'}{node.kind === 'database' ? ' (database)' : ''}</option>
            ))}
          </select>
        </label>
        <label className="field"><span>Notion integration secret</span>
          <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder="ntn_…" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label className="field"><span>Notion page to put it under</span>
          <input className="input" spellCheck={false} placeholder="https://www.notion.so/Team-Space-1a2b3c…" value={parent} onChange={(e) => setParent(e.target.value)} />
          {parent.trim() && <span className={parentId ? 'subtle st-plain' : 'err'}>{parentId ? `Notion page id ${parentId}` : 'Paste the page’s link (Share → Copy link) or its 32-character id.'}</span>}
        </label>
        <div className="row"><button className="btn primary" disabled={!pageId || !token.trim() || !parentId || busy} onClick={send}><Send size={15} />Send to Notion</button></div>
        <span className="subtle">The secret is used once for this export and never stored. Relations and people become plain text in Notion.</span>
        {error && <p className="err" role="alert">{error}</p>}
        {jobId && <JobProgress key={jobId} id={jobId} onOpen={onClose} />}
      </section>
    </>
  );
}

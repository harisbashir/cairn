import { useState } from 'react';
import type { ApiToken } from '../../../shared/types.ts';
import { del, post, timeAgo, useTokens } from '../api.ts';
import { AiTag } from '../Home.tsx';
import { useShell } from '../Shell.tsx';
import { CopyButton, useUi } from '../ui.tsx';
import { Code, LoadNote, Loading, useAct } from './common.tsx';
import { useConnectedApps } from './hooks.ts';

export function AiSection() {
  const s = useShell();
  const act = useAct();
  const ui = useUi();
  const tokens = useTokens();
  const apps = useConnectedApps();
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('write');
  const [scope, setScope] = useState('');
  const [secret, setSecret] = useState('');
  const url = `${location.origin}/mcp`;
  const shown = secret || 'YOUR_TOKEN';
  const wsName = (id: string | null) => (id ? s.boot.workspaces.find((w) => w.id === id)?.name ?? 'One workspace' : 'All my workspaces');
  return (
    <>
      <h2>AI & MCP</h2>
      <p className="muted">Cairn has a built-in MCP server. Connect Claude, ChatGPT, Codex, Cursor or any MCP client and it can search, read and write your pages and databases. Everything an agent changes is marked <AiTag /> and kept in version history.</p>

      <h3>Connect with a sign-in (no token)</h3>
      <section>
        <p className="muted">Clients that add connectors by address, such as claude.ai or ChatGPT, sign in with OAuth. Add a custom connector, enter this MCP address, then approve the request when Cairn asks.</p>
        <Code text={url} label="Copy MCP address" />
      </section>

      <h3>Connected apps</h3>
      {apps.isPending && <Loading what="connected apps" />}
      {apps.isError && <LoadNote what="connected apps" error={apps.error} retry={() => apps.refetch()} />}
      {apps.data?.length === 0 && <p className="subtle">No apps have signed in yet.</p>}
      {!!apps.data?.length && (
        <table className="stable st-cards"><thead><tr><th>App</th><th>Access</th><th>Connected</th><th>Last used</th><th><span className="st-sr">Actions</span></th></tr></thead><tbody>
          {apps.data.map((a) => (
            <tr key={a.id}>
              <td data-label="App"><b>{a.clientName}</b></td>
              <td data-label="Access">{a.access === 'write' ? 'Read and write' : 'Read only'}</td>
              <td data-label="Connected" className="subtle">{timeAgo(a.createdAt)}</td>
              <td data-label="Last used" className="subtle">{a.lastUsedAt ? timeAgo(a.lastUsedAt) : 'Never'}</td>
              <td className="st-act"><button className="btn small danger" onClick={async () => {
                if (await ui.confirm({ title: `Revoke access for “${a.clientName}”?`, body: 'It loses access to Cairn immediately. You can connect it again later.', action: 'Revoke Access', danger: true })) {
                  act(async () => { await del(`/api/connected-apps/${a.id}`); await apps.refetch(); }, `${a.clientName} can no longer reach Cairn`);
                }
              }}>Revoke</button></td>
            </tr>
          ))}
        </tbody></table>
      )}

      <h3>Connect with a token</h3>
      <p className="muted st-help">For Claude Code, Codex, Cursor and clients that send a fixed header.</p>
      <section>
        <span className="subtle"><b>1.</b> Create an access token</span>
        <div className="row st-wrap st-end">
          <label className="field grow"><span>Name</span><input className="input" placeholder="Claude Code on my laptop" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Access</span>
            <select className="select" value={access} onChange={(e) => setAccess(e.target.value as 'read' | 'write')}><option value="write">Read and write</option><option value="read">Read only</option></select>
          </label>
          <label className="field"><span>Scope</span>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All my workspaces</option>{s.boot.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </div>
        <div className="row"><button className="btn primary" disabled={!name.trim()} onClick={() => act(async () => {
          const res = await post<{ token: ApiToken; secret: string }>('/api/tokens', { name: name.trim(), access, workspaceId: scope || undefined });
          setSecret(res.secret); setName(''); tokens.refetch();
        })}>Create Token</button></div>
        {secret && (
          <div>
            <div className="codebox">{secret}<CopyButton text={secret} label="Copy token" /></div>
            <p className="subtle" style={{ marginTop: 6 }}>Copy this token now. For your security it won’t be shown again.</p>
          </div>
        )}
        <span className="subtle"><b>2.</b> Add Cairn to your AI client. Claude Code:</span>
        <Code text={`claude mcp add --transport http cairn ${url} --header "Authorization: Bearer ${shown}"`} />
        <span className="subtle">Codex, Cursor and other clients (mcp.json):</span>
        <Code text={JSON.stringify({ mcpServers: { cairn: { type: 'http', url, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2)} />
      </section>

      <h3>Your tokens</h3>
      {tokens.isError && <LoadNote what="your tokens" error={tokens.error} retry={() => tokens.refetch()} />}
      {tokens.data?.length === 0 && <p className="subtle">No tokens yet.</p>}
      {!!tokens.data?.length && (
        <table className="stable st-cards"><thead><tr><th>Name</th><th>Access</th><th>Scope</th><th>Last used</th><th><span className="st-sr">Actions</span></th></tr></thead><tbody>
          {tokens.data.map((t) => (
            <tr key={t.id}>
              <td data-label="Name"><b>{t.name}</b><div className="subtle">{t.prefix}…</div></td>
              <td data-label="Access">{t.access === 'write' ? 'Read and write' : 'Read only'}</td>
              <td data-label="Scope">{wsName(t.workspaceId)}</td>
              <td data-label="Last used" className="subtle">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'Never'}</td>
              <td className="st-act"><button className="btn small danger" onClick={async () => {
                if (await ui.confirm({ title: `Revoke “${t.name}”?`, body: 'Any AI client using this token loses access immediately.', action: 'Revoke Token', danger: true })) act(async () => { await del(`/api/tokens/${t.id}`); tokens.refetch(); });
              }}>Revoke</button></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </>
  );
}

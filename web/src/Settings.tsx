import { Building2, Plus, ShieldCheck, Sparkles, Trash2, UserCircle, Users, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AdminSettings, ApiToken, Invite, Role, User, WorkspaceSummary } from '../../shared/types.ts';
import {
  del, patch, post, qc, timeAgo, useAdminOverview, useAdminSettings, useAdminUsers, useAdminWorkspaces, useInvites, useMembers, useTokens,
} from './api.ts';
import { AiTag } from './Home.tsx';
import { useShell } from './Shell.tsx';
import { Avatar, CopyButton, EmojiPicker, Modal, Popover, Switch, useUi, WsBadge, WS_COLORS } from './ui.tsx';

export type SettingsSection = 'account' | 'workspace' | 'members' | 'ai' | 'admin';

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control, including deleting the workspace', admin: 'Manages members and settings', member: 'Creates and edits pages', viewer: 'Reads only',
};

function useAct() {
  const ui = useUi();
  return async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); if (done) ui.toast(done); return true; } catch (err) { ui.toast((err as Error).message); return false; }
  };
}

export function SettingsModal({ section, onSection, onClose }: { section: SettingsSection; onSection: (s: SettingsSection) => void; onClose: () => void }) {
  const s = useShell();
  const manages = s.workspace.role === 'owner' || s.workspace.role === 'admin';
  const item = (id: SettingsSection, icon: ReactNode, label: string) => (
    <button className={`side-item${section === id ? ' active' : ''}`} onClick={() => onSection(id)} aria-current={section === id}>{icon}{label}</button>
  );
  return (
    <Modal onClose={onClose} className="settings" label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="side-head" style={{ marginTop: 0 }}>You</div>
        {item('account', <UserCircle size={16} />, 'My Account')}
        {item('ai', <Sparkles size={16} />, 'AI & MCP')}
        <div className="side-head">{s.workspace.name}</div>
        {item('workspace', <Building2 size={16} />, 'General')}
        {item('members', <Users size={16} />, 'Members')}
        {s.user.isAdmin && (<><div className="side-head">Server</div>{item('admin', <ShieldCheck size={16} />, 'Administration')}</>)}
      </nav>
      <div className="settings-body">
        <button className="icon-btn" style={{ float: 'right' }} aria-label="Close settings" onClick={onClose}><X size={18} /></button>
        {section === 'account' && <Account />}
        {section === 'ai' && <AiSection />}
        {section === 'workspace' && <WorkspaceSection manages={manages} onClose={onClose} />}
        {section === 'members' && <MembersSection manages={manages} />}
        {section === 'admin' && s.user.isAdmin && <AdminSection />}
      </div>
    </Modal>
  );
}

function Account() {
  const s = useShell();
  const act = useAct();
  const [name, setName] = useState(s.user.name);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <>
      <h2>My Account</h2>
      <p className="muted">{s.user.email}</p>
      <h3>Profile</h3>
      <section>
        <div className="row"><Avatar name={name} color={s.user.color} large />
          <label className="field grow"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!name.trim() || name === s.user.name} onClick={() => act(async () => { await patch('/api/me', { name: name.trim() }); await qc.invalidateQueries({ queryKey: ['bootstrap'] }); }, 'Name saved')}>Save Name</button>
        </div>
      </section>
      <h3>Password</h3>
      <section>
        <label className="field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <div className="row">
          <button className="btn" disabled={!cur || next.length < 8} onClick={async () => { if (await act(() => patch('/api/me', { currentPassword: cur, newPassword: next }), 'Password changed')) { setCur(''); setNext(''); } }}>Change Password</button>
          <span className="subtle">At least 8 characters.</span>
        </div>
      </section>
    </>
  );
}

function AiSection() {
  const s = useShell();
  const act = useAct();
  const ui = useUi();
  const tokens = useTokens();
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
      <p className="muted">Cairn has a built-in MCP server. Connect Claude, Codex, Cursor or any MCP client and it can search, read and write your pages and databases. Everything an agent changes is marked <AiTag /> and kept in version history.</p>

      <h3>1. Create an access token</h3>
      <section>
        <div className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
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
      </section>

      <h3>2. Add Cairn to your AI client</h3>
      <section>
        <span className="subtle">Claude Code</span>
        <Code text={`claude mcp add --transport http cairn ${url} --header "Authorization: Bearer ${shown}"`} />
        <span className="subtle">Codex, Cursor and other clients (mcp.json)</span>
        <Code text={JSON.stringify({ mcpServers: { cairn: { type: 'http', url, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2)} />
      </section>

      <h3>Your tokens</h3>
      {tokens.data?.length === 0 && <p className="subtle">No tokens yet.</p>}
      {!!tokens.data?.length && (
        <table className="stable"><thead><tr><th>Name</th><th>Access</th><th>Scope</th><th>Last used</th><th /></tr></thead><tbody>
          {tokens.data.map((t) => (
            <tr key={t.id}>
              <td><b>{t.name}</b><div className="subtle">{t.prefix}…</div></td>
              <td>{t.access === 'write' ? 'Read and write' : 'Read only'}</td>
              <td>{wsName(t.workspaceId)}</td>
              <td className="subtle">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'Never'}</td>
              <td style={{ textAlign: 'right' }}><button className="btn small danger" onClick={async () => {
                if (await ui.confirm({ title: `Revoke “${t.name}”?`, body: 'Any AI client using this token loses access immediately.', action: 'Revoke Token', danger: true })) act(async () => { await del(`/api/tokens/${t.id}`); tokens.refetch(); });
              }}>Revoke</button></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </>
  );
}

function Code({ text }: { text: string }) {
  return <div className="codebox">{text}<CopyButton text={text} /></div>;
}

function WorkspaceSection({ manages, onClose }: { manages: boolean; onClose: () => void }) {
  const s = useShell();
  const act = useAct();
  const ui = useUi();
  const navigate = useNavigate();
  const [name, setName] = useState(s.workspace.name);
  const update = (body: Partial<WorkspaceSummary>, done?: string) => act(async () => { await patch(`/api/workspaces/${s.wid}`, body); await qc.invalidateQueries({ queryKey: ['bootstrap'] }); }, done);
  return (
    <>
      <h2>General</h2>
      <p className="muted">How this workspace appears to its members.</p>
      <h3>Identity</h3>
      <section>
        <div className="row" style={{ alignItems: 'end' }}>
          {manages ? (
            <Popover trigger={(p) => <button className="btn" style={{ height: 36, width: 44, padding: 0 }} aria-label="Change workspace icon" {...p}><WsBadge {...s.workspace} /></button>}>
              <EmojiPicker onPick={(e) => update({ icon: e })} allowRemove />
            </Popover>
          ) : <WsBadge {...s.workspace} />}
          <label className="field grow"><span>Name</span><input className="input" value={name} disabled={!manages} onChange={(e) => setName(e.target.value)} /></label>
          {manages && <button className="btn primary" disabled={!name.trim() || name === s.workspace.name} onClick={() => update({ name: name.trim() }, 'Workspace renamed')}>Save</button>}
        </div>
        {manages && (
          <div className="field"><span>Colour</span>
            <div className="color-dots" style={{ padding: 0 }}>
              {WS_COLORS.map((c) => <button key={c} aria-label={`Colour ${c}`} className={c === s.workspace.color ? 'on' : ''} style={{ background: c, width: 24, height: 24 }} onClick={() => update({ color: c })} />)}
            </div>
          </div>
        )}
      </section>
      <h3>Your role</h3>
      <p className="muted">{ROLE_LABEL[s.workspace.role]}: {ROLE_HELP[s.workspace.role].toLowerCase()}.</p>
      <h3>Danger zone</h3>
      <section>
        <div className="row">
          <button className="btn danger" onClick={async () => {
            if (await ui.confirm({ title: `Leave ${s.workspace.name}?`, body: 'You lose access to its pages until someone invites you again.', action: 'Leave Workspace', danger: true })) {
              if (await act(() => del(`/api/workspaces/${s.wid}/members/${s.user.id}`))) { await qc.invalidateQueries({ queryKey: ['bootstrap'] }); onClose(); navigate('/'); }
            }
          }}>Leave Workspace</button>
          {s.workspace.role === 'owner' && <button className="btn danger" onClick={async () => {
            if (await ui.confirm({ title: `Delete ${s.workspace.name}?`, body: 'Every page, database and file in this workspace is deleted for all members. You can’t undo this.', action: 'Delete Workspace', danger: true })) {
              if (await act(() => del(`/api/workspaces/${s.wid}`))) { await qc.invalidateQueries({ queryKey: ['bootstrap'] }); onClose(); navigate('/'); }
            }
          }}><Trash2 size={15} />Delete Workspace</button>}
        </div>
      </section>
    </>
  );
}

function RoleSelect({ value, onChange, allowOwner, label }: { value: Role; onChange: (r: Role) => void; allowOwner: boolean; label: string }) {
  return (
    <select className="select small" style={{ width: 110 }} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Role)}>
      {(['owner', 'admin', 'member', 'viewer'] as Role[]).filter((r) => r !== 'owner' || allowOwner || value === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
    </select>
  );
}

function MembersSection({ manages }: { manages: boolean }) {
  const s = useShell();
  const act = useAct();
  const ui = useUi();
  const members = useMembers(s.wid);
  const invites = useInvites(s.wid, manages);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const link = (i: Invite) => `${location.origin}/invite/${i.token}`;
  const isOwner = s.workspace.role === 'owner';
  return (
    <>
      <h2>Members</h2>
      <p className="muted">People in {s.workspace.name} see every page except private ones.</p>
      {manages && (
        <>
          <h3>Invite someone</h3>
          <section>
            <div className="row" style={{ alignItems: 'end' }}>
              <label className="field grow"><span>Email (optional)</span><input className="input" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <RoleSelect value={role} onChange={setRole} allowOwner={false} label="Role for the invite" />
              <button className="btn primary" onClick={() => act(async () => {
                const inv = await post<Invite>(`/api/workspaces/${s.wid}/invites`, { email: email.trim() || undefined, role });
                await navigator.clipboard.writeText(link(inv)).catch(() => {});
                setEmail(''); invites.refetch();
              }, 'Invite link copied. Send it to them.')}><Plus size={15} />Create Invite Link</button>
            </div>
            <span className="subtle">Cairn doesn’t send email yet. Share the link yourself; it works once and expires in 14 days.</span>
            {invites.data?.map((i) => (
              <div key={i.id} className="row">
                <span className="grow"><b>{i.email ?? 'Anyone with the link'}</b> <span className="subtle">· {ROLE_LABEL[i.role]} · expires {new Date(i.expiresAt).toLocaleDateString()}</span></span>
                <CopyButton text={link(i)} label="Copy invite link" />
                <button className="icon-btn" aria-label="Cancel invite" title="Cancel invite" onClick={() => act(async () => { await del(`/api/workspaces/${s.wid}/invites/${i.id}`); invites.refetch(); })}><X size={15} /></button>
              </div>
            ))}
          </section>
        </>
      )}
      <h3>{members.data?.length ?? ''} {members.data?.length === 1 ? 'member' : 'members'}</h3>
      <table className="stable"><tbody>
        {members.data?.map((m) => (
          <tr key={m.userId}>
            <td style={{ width: 36 }}><Avatar name={m.name} color={m.color} /></td>
            <td><b>{m.name}</b>{m.userId === s.user.id && <span className="subtle"> (you)</span>}<div className="subtle">{m.email}</div></td>
            <td style={{ textAlign: 'right' }}>
              {manages && m.userId !== s.user.id && (m.role !== 'owner' || isOwner)
                ? <RoleSelect value={m.role} allowOwner={isOwner} label={`Role of ${m.name}`} onChange={(r) => act(async () => { await patch(`/api/workspaces/${s.wid}/members/${m.userId}`, { role: r }); members.refetch(); })} />
                : <span className="muted">{ROLE_LABEL[m.role]}</span>}
            </td>
            <td style={{ width: 36 }}>
              {manages && m.userId !== s.user.id && (m.role !== 'owner' || isOwner) && (
                <button className="icon-btn" aria-label={`Remove ${m.name}`} title="Remove from workspace" onClick={async () => {
                  if (await ui.confirm({ title: `Remove ${m.name}?`, body: `They lose access to ${s.workspace.name}.`, action: 'Remove Member', danger: true })) act(async () => { await del(`/api/workspaces/${s.wid}/members/${m.userId}`); members.refetch(); });
                }}><X size={15} /></button>
              )}
            </td>
          </tr>
        ))}
      </tbody></table>
    </>
  );
}

function fmtBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function AdminSection() {
  const s = useShell();
  const act = useAct();
  const ui = useUi();
  const overview = useAdminOverview();
  const users = useAdminUsers();
  const workspaces = useAdminWorkspaces();
  const settings = useAdminSettings();
  const [adding, setAdding] = useState(false);
  const [instanceName, setInstanceName] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const setSetting = (body: Partial<AdminSettings>) => act(async () => { await patch('/api/admin/settings', body); refresh(); qc.invalidateQueries({ queryKey: ['bootstrap'] }); });
  const setUser = (u: User, body: Record<string, unknown>, done?: string) => act(async () => { await patch(`/api/admin/users/${u.id}`, body); refresh(); }, done);
  const o = overview.data;
  return (
    <>
      <h2>Administration</h2>
      <p className="muted">Manage this Cairn server. Administrators manage accounts and workspaces but can’t read workspace content they aren’t a member of.</p>
      {o && (
        <div className="stat-grid" style={{ marginTop: 16 }}>
          <div className="stat"><b>{o.users}</b><span>People</span></div>
          <div className="stat"><b>{o.workspaces}</b><span>Workspaces</span></div>
          <div className="stat"><b>{o.pages}</b><span>Pages</span></div>
          <div className="stat"><b>{o.databases}</b><span>Databases</span></div>
          <div className="stat"><b>{o.rows}</b><span>Rows</span></div>
          <div className="stat"><b>{o.aiEdits7d}</b><span>AI edits, 7 days</span></div>
          <div className="stat"><b>{fmtBytes(o.storageBytes)}</b><span>Storage</span></div>
        </div>
      )}

      <h3>Sign-up</h3>
      {settings.data && (
        <section>
          <div className="row">
            <span className="grow"><b>Allow anyone to create an account</b><div className="subtle">When off, people can only join with an invite link or an account you create.</div></span>
            <Switch on={settings.data.allowSignup} onChange={(v) => setSetting({ allowSignup: v })} label="Allow anyone to create an account" />
          </div>
          <div className="row" style={{ alignItems: 'end' }}>
            <label className="field grow"><span>Server name</span><input className="input" value={instanceName ?? settings.data.instanceName} onChange={(e) => setInstanceName(e.target.value)} /></label>
            <button className="btn" disabled={instanceName === null || !instanceName.trim() || instanceName === settings.data.instanceName} onClick={async () => { await setSetting({ instanceName: instanceName!.trim() }); setInstanceName(null); }}>Save</button>
          </div>
        </section>
      )}

      <h3 className="row">People<span className="grow" /><button className="btn small" onClick={() => setAdding(true)}><Plus size={14} />Add Person</button></h3>
      <table className="stable"><thead><tr><th>Person</th><th>Workspaces</th><th>Last seen</th><th>Administrator</th><th>Active</th><th /></tr></thead><tbody>
        {users.data?.map((u) => {
          const me = u.id === s.user.id;
          return (
            <tr key={u.id} style={u.disabled ? { opacity: 0.6 } : undefined}>
              <td><div className="row"><Avatar name={u.name} color={u.color} /><span><b>{u.name}</b>{me && <span className="subtle"> (you)</span>}<div className="subtle">{u.email}</div></span></div></td>
              <td>{u.workspaces}</td>
              <td className="subtle">{u.lastSeenAt ? timeAgo(u.lastSeenAt) : 'Never'}</td>
              <td>{me ? <span className="subtle">Yes</span> : <Switch on={u.isAdmin} onChange={(v) => setUser(u, { isAdmin: v })} label={`${u.name} is an administrator`} />}</td>
              <td>{me ? <span className="subtle">Yes</span> : <Switch on={!u.disabled} onChange={(v) => setUser(u, { disabled: !v })} label={`${u.name} can sign in`} />}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {!me && (<>
                  <button className="btn small" onClick={async () => {
                    const pw = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
                    if (await ui.confirm({ title: `Reset ${u.name}’s password?`, body: `Their new temporary password will be: ${pw}  — copy it now and send it to them.`, action: 'Reset Password' })) setUser(u, { password: pw }, 'Password reset');
                  }}>Reset Password</button>{' '}
                  <button className="icon-btn" aria-label={`Delete ${u.name}`} title="Delete account" onClick={async () => {
                    if (await ui.confirm({ title: `Delete ${u.name}’s account?`, body: 'Workspaces only they belong to are deleted too. You can’t undo this.', action: 'Delete Account', danger: true })) act(async () => { await del(`/api/admin/users/${u.id}`); refresh(); });
                  }}><Trash2 size={15} /></button>
                </>)}
              </td>
            </tr>
          );
        })}
      </tbody></table>

      <h3>Workspaces</h3>
      <table className="stable"><thead><tr><th>Workspace</th><th>Owner</th><th>Members</th><th>Pages</th><th>Created</th><th /></tr></thead><tbody>
        {workspaces.data?.map((w) => (
          <tr key={w.id}>
            <td><div className="row"><WsBadge {...w} /><b>{w.name}</b></div></td>
            <td>{w.ownerName}</td><td>{w.members}</td><td>{w.pages}</td>
            <td className="subtle">{new Date(w.createdAt).toLocaleDateString()}</td>
            <td style={{ textAlign: 'right' }}><button className="icon-btn" aria-label={`Delete ${w.name}`} title="Delete workspace" onClick={async () => {
              if (await ui.confirm({ title: `Delete ${w.name}?`, body: `This deletes ${w.pages} pages for ${w.members} ${w.members === 1 ? 'member' : 'members'}. You can’t undo this.`, action: 'Delete Workspace', danger: true })) act(async () => { await del(`/api/admin/workspaces/${w.id}`); refresh(); qc.invalidateQueries({ queryKey: ['bootstrap'] }); });
            }}><Trash2 size={15} /></button></td>
          </tr>
        ))}
      </tbody></table>
      {adding && <AddPerson onClose={() => { setAdding(false); refresh(); }} />}
    </>
  );
}

function AddPerson({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal onClose={onClose} label="Add a person">
      <h2>Add a Person</h2>
      <form style={{ display: 'grid', gap: 12 }} onSubmit={async (e) => {
        e.preventDefault();
        try { await post('/api/admin/users', { email, name, password }); onClose(); } catch (err) { setError((err as Error).message); }
      }}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
        <label className="field"><span>Email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Temporary password</span><input className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>
        {error && <p className="err">{error}</p>}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Add Person</button></div>
      </form>
    </Modal>
  );
}

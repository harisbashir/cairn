import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AdminSettings, User } from '../../../shared/types.ts';
import { del, patch, post, qc, timeAgo, useAdminOverview, useAdminSettings, useAdminUsers, useAdminWorkspaces } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { Avatar, Modal, Switch, useUi, WsBadge } from '../ui.tsx';
import { fmtBytes, LoadNote, useAct } from './common.tsx';

export function AdminSection() {
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
        <div className="stat-grid st-stats">
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
      {settings.isError && <LoadNote what="server settings" error={settings.error} retry={() => settings.refetch()} />}
      {settings.data && (
        <section>
          <div className="row">
            <span className="grow"><b>Allow anyone to create an account</b><div className="subtle">When off, people can only join with an invite link or an account you create.</div></span>
            <Switch on={settings.data.allowSignup} onChange={(v) => setSetting({ allowSignup: v })} label="Allow anyone to create an account" />
          </div>
          <div className="row st-end">
            <label className="field grow"><span>Server name</span><input className="input" value={instanceName ?? settings.data.instanceName} onChange={(e) => setInstanceName(e.target.value)} /></label>
            <button className="btn" disabled={instanceName === null || !instanceName.trim() || instanceName === settings.data.instanceName} onClick={async () => { await setSetting({ instanceName: instanceName!.trim() }); setInstanceName(null); }}>Save</button>
          </div>
        </section>
      )}

      <h3 className="st-h3">People<span className="st-h3-actions"><button className="btn small" onClick={() => setAdding(true)}><Plus size={14} />Add Person</button></span></h3>
      <table className="stable st-cards"><thead><tr><th>Person</th><th>Workspaces</th><th>Last seen</th><th>Administrator</th><th>Active</th><th><span className="st-sr">Actions</span></th></tr></thead><tbody>
        {users.data?.map((u) => {
          const me = u.id === s.user.id;
          return (
            <tr key={u.id} className={u.disabled ? 'st-dim' : undefined}>
              <td className="st-break"><div className="row"><Avatar name={u.name} color={u.color} /><span><b>{u.name}</b>{me && <span className="subtle"> (you)</span>}<div className="subtle">{u.email}</div></span></div></td>
              <td data-label="Workspaces">{u.workspaces}</td>
              <td data-label="Last seen" className="subtle">{u.lastSeenAt ? timeAgo(u.lastSeenAt) : 'Never'}</td>
              <td data-label="Administrator">{me ? <span className="subtle">Yes</span> : <Switch on={u.isAdmin} onChange={(v) => setUser(u, { isAdmin: v })} label={`${u.name} is an administrator`} />}</td>
              <td data-label="Active">{me ? <span className="subtle">Yes</span> : <Switch on={!u.disabled} onChange={(v) => setUser(u, { disabled: !v })} label={`${u.name} can sign in`} />}</td>
              <td className="st-act">
                {!me && (<>
                  <button className="btn small" onClick={async () => {
                    const pw = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
                    if (await ui.confirm({ title: `Reset ${u.name}’s password?`, body: `Their new temporary password will be: ${pw}  — copy it now and send it to them.`, action: 'Reset Password' })) setUser(u, { password: pw }, 'Password reset');
                  }}>Reset Password</button>
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
      <table className="stable st-cards"><thead><tr><th>Workspace</th><th>Owner</th><th>Members</th><th>Pages</th><th>Created</th><th><span className="st-sr">Actions</span></th></tr></thead><tbody>
        {workspaces.data?.map((w) => (
          <tr key={w.id}>
            <td><div className="row"><WsBadge {...w} /><b>{w.name}</b></div></td>
            <td data-label="Owner">{w.ownerName}</td><td data-label="Members">{w.members}</td><td data-label="Pages">{w.pages}</td>
            <td data-label="Created" className="subtle">{new Date(w.createdAt).toLocaleDateString()}</td>
            <td className="st-act"><button className="icon-btn" aria-label={`Delete ${w.name}`} title="Delete workspace" onClick={async () => {
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
    <Modal onClose={onClose} label="Add a person" className="modal st-dialog">
      <h2>Add a Person</h2>
      <form className="st-form" onSubmit={async (e) => {
        e.preventDefault();
        try { await post('/api/admin/users', { email, name, password }); onClose(); } catch (err) { setError((err as Error).message); }
      }}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
        <label className="field"><span>Email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Temporary password</span><input className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Add Person</button></div>
      </form>
    </Modal>
  );
}

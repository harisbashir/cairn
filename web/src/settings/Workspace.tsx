import { ChevronRight, ExternalLink, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Invite, Role, WorkspaceSummary } from '../../../shared/types.ts';
import { del, patch, post, qc, timeAgo, useInvites, useMembers } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { Avatar, CopyButton, EmojiPicker, Popover, useUi, WsBadge, WS_COLORS } from '../ui.tsx';
import { fmtBytes, ROLE_HELP, ROLE_LABEL, useAct } from './common.tsx';
import { useWorkspaceFiles } from './hooks.ts';

export function WorkspaceSection({ manages, onClose }: { manages: boolean; onClose: () => void }) {
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
        <div className="row st-end">
          {manages ? (
            <Popover trigger={(p) => <button className="btn st-icon-pick" aria-label="Change workspace icon" {...p}><WsBadge {...s.workspace} /></button>}>
              <EmojiPicker onPick={(e) => update({ icon: e })} allowRemove />
            </Popover>
          ) : <WsBadge {...s.workspace} />}
          <label className="field grow"><span>Name</span><input className="input" value={name} disabled={!manages} onChange={(e) => setName(e.target.value)} /></label>
          {manages && <button className="btn primary" disabled={!name.trim() || name === s.workspace.name} onClick={() => update({ name: name.trim() }, 'Workspace renamed')}>Save</button>}
        </div>
        {manages && (
          <div className="field"><span>Colour</span>
            <div className="color-dots st-ws-colors">
              {WS_COLORS.map((c) => <button key={c} aria-label={`Colour ${c}`} aria-pressed={c === s.workspace.color} className={c === s.workspace.color ? 'on' : ''} style={{ background: c }} onClick={() => update({ color: c })} />)}
            </div>
          </div>
        )}
      </section>
      <h3>Your role</h3>
      <p className="muted">{ROLE_LABEL[s.workspace.role]}: {ROLE_HELP[s.workspace.role].toLowerCase()}.</p>
      <StorageList />
      <h3>Danger zone</h3>
      <section>
        <div className="row st-wrap">
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

/** Uploaded files, shown only when the server can list them. */
function StorageList() {
  const s = useShell();
  const ui = useUi();
  const act = useAct();
  const files = useWorkspaceFiles(s.wid);
  if (!files.data) return null;
  const total = files.data.reduce((sum, f) => sum + f.size, 0);
  return (
    <>
      <h3>Storage</h3>
      <details className="st-details">
        <summary><ChevronRight size={15} className="st-twist" aria-hidden />Uploaded files<span className="subtle">{files.data.length} {files.data.length === 1 ? 'file' : 'files'}{files.data.length > 0 && ` · ${fmtBytes(total)}`}</span></summary>
        {files.data.length === 0 ? <p className="subtle st-pad">Nothing uploaded yet. Images and files you add to pages appear here.</p> : (
          <table className="stable st-cards"><thead><tr><th>Name</th><th>Size</th><th>Uploaded by</th><th>Date</th><th><span className="st-sr">Actions</span></th></tr></thead><tbody>
            {files.data.map((f) => (
              <tr key={f.id}>
                <td data-label="Name" className="st-break"><b>{f.name}</b></td>
                <td data-label="Size">{fmtBytes(f.size)}</td>
                <td data-label="Uploaded by">{f.createdByName}</td>
                <td data-label="Date" className="subtle">{timeAgo(f.createdAt)}</td>
                <td className="st-act">
                  <a className="icon-btn" href={f.url} target="_blank" rel="noreferrer" aria-label={`Open ${f.name}`} title="Open"><ExternalLink size={15} /></a>
                  <button className="icon-btn" aria-label={`Delete ${f.name}`} title="Delete file" onClick={async () => {
                    if (await ui.confirm({ title: `Delete “${f.name}”?`, body: 'Pages that show this file will show a broken image or link instead. You can’t undo this.', action: 'Delete File', danger: true })) {
                      act(async () => { await del(`/api/files/${f.id}`); await files.refetch(); }, 'File deleted');
                    }
                  }}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </details>
    </>
  );
}

function RoleSelect({ value, onChange, allowOwner, label }: { value: Role; onChange: (r: Role) => void; allowOwner: boolean; label: string }) {
  return (
    <select className="select small st-role" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Role)}>
      {(['owner', 'admin', 'member', 'viewer'] as Role[]).filter((r) => r !== 'owner' || allowOwner || value === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
    </select>
  );
}

export function MembersSection({ manages }: { manages: boolean }) {
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
            <div className="row st-wrap st-end">
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
      <table className="stable st-members"><tbody>
        {members.data?.map((m) => {
          const editable = manages && m.userId !== s.user.id && (m.role !== 'owner' || isOwner);
          return (
            <tr key={m.userId}>
              <td className="st-avatar-cell"><Avatar name={m.name} color={m.color} /></td>
              <td className="st-break"><b>{m.name}</b>{m.userId === s.user.id && <span className="subtle"> (you)</span>}<div className="subtle">{m.email}</div></td>
              <td className="st-act">
                {editable
                  ? <RoleSelect value={m.role} allowOwner={isOwner} label={`Role of ${m.name}`} onChange={(r) => act(async () => { await patch(`/api/workspaces/${s.wid}/members/${m.userId}`, { role: r }); members.refetch(); })} />
                  : <span className="muted">{ROLE_LABEL[m.role]}</span>}
                {editable && (
                  <button className="icon-btn" aria-label={`Remove ${m.name}`} title="Remove from workspace" onClick={async () => {
                    if (await ui.confirm({ title: `Remove ${m.name}?`, body: `They lose access to ${s.workspace.name}.`, action: 'Remove Member', danger: true })) act(async () => { await del(`/api/workspaces/${s.wid}/members/${m.userId}`); members.refetch(); });
                  }}><X size={15} /></button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody></table>
    </>
  );
}

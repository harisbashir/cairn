import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Bootstrap, InstanceInfo, Role, WorkspaceSummary } from '../../shared/types.ts';
import { get, post, qc } from './api.ts';

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

export function AuthPage({ mode, instance, inviteToken, inviteEmail, stay }: { mode: 'login' | 'signup'; instance: InstanceInfo; inviteToken?: string; inviteEmail?: string; stay?: boolean }) {
  const [email, setEmail] = useState(inviteEmail ?? '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const signup = mode === 'signup';
  const { busy, error, submit } = useSubmit(async () => {
    const boot = await post<Bootstrap>(signup ? '/api/auth/signup' : '/api/auth/login', signup ? { email, name, password, inviteToken } : { email, password });
    qc.setQueryData(['bootstrap'], boot);
    if (!stay) navigate('/', { replace: true });
  });
  const canSignup = instance.needsSetup || instance.allowSignup || !!inviteToken;
  return (
    <div className="auth">
      <div className="auth-card">
        <img src="/logo.svg" alt="" />
        <div>
          <h1>{instance.needsSetup ? 'Set up Cairn' : signup ? 'Create your account' : `Sign in to ${instance.name || 'Cairn'}`}</h1>
          {instance.needsSetup && <p className="muted" style={{ marginTop: 6 }}>This first account becomes the administrator.</p>}
        </div>
        <form onSubmit={submit}>
          {signup && (
            <label className="field"><span>Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus />
            </label>
          )}
          <label className="field"><span>Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus={!signup} />
          </label>
          <label className="field"><span>Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 8 : undefined} required />
            {signup && <span className="subtle" style={{ fontWeight: 400 }}>At least 8 characters.</span>}
          </label>
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn primary large" disabled={busy}>{signup ? 'Create Account' : 'Sign In'}</button>
        </form>
        {!instance.needsSetup && !inviteToken && (
          <p className="auth-foot">
            {signup ? <>Already have an account? <Link to="/">Sign in</Link></>
              : canSignup ? <>New here? <Link to="/signup">Create an account</Link></>
              : 'Ask your administrator for an invite to join.'}
          </p>
        )}
      </div>
    </div>
  );
}

interface InviteInfo { workspaceName: string; workspaceIcon: string; inviterName: string; role: Role; email: string | null }

export function InvitePage({ boot }: { boot: Bootstrap }) {
  const { token } = useParams();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => get<InviteInfo>(`/api/invites/${token}`), retry: false });
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const { busy, error, submit } = useSubmit(async () => {
    const ws = await post<WorkspaceSummary>(`/api/invites/${token}/accept`);
    await qc.invalidateQueries({ queryKey: ['bootstrap'] });
    navigate(`/w/${ws.id}`, { replace: true });
  });
  if (info.isPending) return null;
  if (info.isError) {
    return (
      <div className="auth"><div className="auth-card">
        <img src="/logo.svg" alt="" />
        <h1>This invite is no longer valid</h1>
        <p className="muted">It may have expired or already been used. Ask for a new one.</p>
        <Link className="btn large" to="/">Go to Cairn</Link>
      </div></div>
    );
  }
  const i = info.data;
  if (boot.user) {
    return (
      <div className="auth"><div className="auth-card">
        <img src="/logo.svg" alt="" />
        <h1>Join {i.workspaceIcon} {i.workspaceName}</h1>
        <p className="muted">{i.inviterName} invited you as {i.role === 'admin' ? 'an admin' : `a ${i.role}`}. You’re signed in as {boot.user.email}.</p>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn primary large" disabled={busy} onClick={() => submit()}>Join Workspace</button>
      </div></div>
    );
  }
  return (
    <div>
      <AuthPage key={mode} mode={mode} instance={boot.instance} inviteToken={mode === 'signup' ? token : undefined} inviteEmail={i.email ?? undefined} stay={mode === 'login'} />
      <p className="auth-foot" style={{ position: 'fixed', bottom: 24, left: 0, right: 0 }}>
        {i.inviterName} invited you to <b>{i.workspaceName}</b>.{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'signup' ? 'login' : 'signup'); }}>
          {mode === 'signup' ? 'I already have an account' : 'Create a new account instead'}
        </a>
      </p>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { OAuthGrantInfo } from '../../shared/types.ts';
import { ApiFailure, get, post, useBootstrap } from './api.ts';
import './settings/settings.css';

/** Approval page for an MCP client or app signing in with OAuth. Mounted at /oauth/consent?request=<id>. */
export function OAuthConsent() {
  const [params] = useSearchParams();
  const id = params.get('request') ?? '';
  const boot = useBootstrap();
  const info = useQuery({ queryKey: ['oauth-request', id], queryFn: () => get<OAuthGrantInfo>(`/api/oauth/requests/${encodeURIComponent(id)}`), enabled: !!id, retry: false, refetchOnWindowFocus: false });
  const [access, setAccess] = useState<'read' | 'write' | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const answer = async (verb: 'approve' | 'deny') => {
    setBusy(true); setError('');
    try {
      const body = verb === 'approve' ? { access: access ?? info.data!.scope, workspaceId: workspaceId || undefined } : {};
      const res = await post<{ redirect: string }>(`/api/oauth/requests/${encodeURIComponent(id)}/${verb}`, body);
      window.location.href = res.redirect;
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  const expired = !id || (info.error instanceof ApiFailure && (info.error.status === 404 || info.error.status === 400));
  return (
    <div className="auth">
      <div className="auth-card st-consent">
        <img src="/logo.svg" alt="" />
        {expired ? (
          <>
            <h1>This sign-in request has expired</h1>
            <p className="muted">Requests last 10 minutes and work once. Go back to the app you were connecting and start again.</p>
          </>
        ) : info.isError ? (
          <>
            <h1>Cairn couldn’t load this request</h1>
            <p className="muted">{info.error.message}</p>
            <button className="btn primary large" onClick={() => info.refetch()}>Try Again</button>
          </>
        ) : !info.data ? (
          <p className="subtle" role="status">Loading…</p>
        ) : (
          <>
            <div>
              <h1>{info.data.clientName} wants to connect to your Cairn</h1>
              <p className="muted st-consent-lead">After you allow it, you’ll go back to <b className="st-break">{info.data.redirectHost}</b>. Only allow apps you trust.</p>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); answer('approve'); }}>
              <fieldset className="st-fieldset">
                <legend className="st-legend">What it can do</legend>
                <div className="st-choices">
                  {(['read', 'write'] as const).map((a) => (
                    <label key={a} className={`st-choice${(access ?? info.data.scope) === a ? ' on' : ''}`}>
                      <input type="radio" name="st-access" value={a} checked={(access ?? info.data.scope) === a} onChange={() => setAccess(a)} />
                      <span><b>{a === 'read' ? 'Read only' : 'Read and write'}</b>
                        <span className="subtle st-block">{a === 'read' ? 'Search and read pages and databases.' : 'Also create and edit pages and rows. Changes are marked AI.'}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {!!boot.data?.workspaces.length && (
                <label className="field"><span>Workspaces</span>
                  <select className="select" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                    <option value="">All my workspaces</option>
                    {boot.data.workspaces.map((w) => <option key={w.id} value={w.id}>Only {w.name}</option>)}
                  </select>
                </label>
              )}
              {error && <p className="err" role="alert">{error}</p>}
              <div className="st-consent-actions">
                <button type="button" className="btn large" disabled={busy} onClick={() => answer('deny')}>Deny</button>
                <button className="btn primary large" disabled={busy}>Allow Access</button>
              </div>
              <p className="subtle">You can revoke its access at any time in Settings → AI & MCP.</p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

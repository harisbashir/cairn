import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { qc, useBootstrap } from './api.ts';
import { AuthPage, InvitePage } from './Auth.tsx';
import { TrashPage } from './Home.tsx';
import { Home } from './home/Dashboard.tsx';
import { PageRoute } from './PageView.tsx';
import { PublicPage } from './PublicPage.tsx';
import { BrowsePage, MorePage, Shell } from './Shell.tsx';
import { applyStoredPrefs } from './theme.ts';
import { OAuthConsent } from './OAuthConsent.tsx';
import { CapturePage } from './inbox/Capture.tsx';
import { ChangesScreen } from './inbox/Changes.tsx';
import { NotificationsScreen, PageRedirect } from './inbox/Notifications.tsx';
import { UiProvider } from './ui.tsx';
import './styles.css';

function Root() {
  const boot = useBootstrap();
  if (boot.isPending) return null;
  if (boot.isError) {
    return (
      <div className="auth"><div className="auth-card">
        <img src="/logo.svg" alt="" />
        <h1>Cairn can’t reach its server</h1>
        <p className="muted">{boot.error.message}</p>
        <button className="btn primary large" onClick={() => boot.refetch()}>Try again</button>
      </div></div>
    );
  }
  const { user, workspaces, instance } = boot.data;
  if (!user) {
    return (
      <Routes>
        <Route path="/invite/:token" element={<InvitePage boot={boot.data} />} />
        <Route path="/signup" element={<AuthPage mode="signup" instance={instance} />} />
        <Route path="/oauth/consent" element={<AuthPage mode="login" instance={instance} stay />} />
        <Route path="*" element={<AuthPage mode={instance.needsSetup ? 'signup' : 'login'} instance={instance} />} />
      </Routes>
    );
  }
  const last = localStorage.getItem('cairn.ws');
  const home = workspaces.find((w) => w.id === last) ?? workspaces[0];
  return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage boot={boot.data} />} />
      <Route path="/oauth/consent" element={<OAuthConsent />} />
      <Route path="/capture" element={<CapturePage />} />
      <Route path="/p/:pid" element={<PageRedirect />} />
      <Route path="/w/:wid" element={<Shell boot={boot.data} />}>
        <Route index element={<Home />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="browse" element={<BrowsePage />} />
        <Route path="more" element={<MorePage />} />
        <Route path="changes" element={<ChangesScreen />} />
        <Route path="notifications" element={<NotificationsScreen />} />
        <Route path="p/:pid" element={<PageRoute />} />
      </Route>
      <Route path="*" element={home ? <Navigate to={`/w/${home.id}`} replace /> : <Shell boot={boot.data} />} />
    </Routes>
  );
}

applyStoredPrefs();
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <UiProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/s/:token" element={<PublicPage />} />
            <Route path="*" element={<Root />} />
          </Routes>
        </BrowserRouter>
      </UiProvider>
    </QueryClientProvider>
  </StrictMode>,
);

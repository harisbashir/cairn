import {
  ArrowLeftRight, Bell, Building2, CalendarDays, ChevronLeft, ChevronRight, DatabaseBackup, Mail, Palette, ShieldCheck, Sparkles, UserCircle, Users, X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useShell } from './Shell.tsx';
import { Modal, useIsPhone } from './ui.tsx';
import { Account, Appearance } from './settings/Account.tsx';
import { AdminSection } from './settings/Admin.tsx';
import { AiSection } from './settings/Ai.tsx';
import { BackupsSection } from './settings/Backups.tsx';
import { CalendarsSection } from './settings/Calendars.tsx';
import { DataSection } from './settings/Data.tsx';
import { MailSection } from './settings/Mail.tsx';
import { NotificationsSection } from './settings/Notifications.tsx';
import { MembersSection, WorkspaceSection } from './settings/Workspace.tsx';
import './settings/settings.css';

export type SettingsSection = 'account' | 'appearance' | 'ai' | 'workspace' | 'members' | 'data' | 'calendars' | 'admin' | 'backups' | 'notifications' | 'mail';

interface NavGroup { label: string; items: { id: SettingsSection; icon: ReactNode; label: string }[] }

export function SettingsModal({ section, onSection, onClose }: { section: SettingsSection; onSection: (s: SettingsSection) => void; onClose: () => void }) {
  const s = useShell();
  const phone = useIsPhone();
  // On phones the section list comes first, unless Settings was opened straight to a specific section.
  const [listing, setListing] = useState(section === 'account');
  const manages = s.workspace.role === 'owner' || s.workspace.role === 'admin';
  const groups: NavGroup[] = [
    { label: 'You', items: [
      { id: 'account', icon: <UserCircle size={16} />, label: 'My Account' },
      { id: 'appearance', icon: <Palette size={16} />, label: 'Appearance' },
      { id: 'notifications', icon: <Bell size={16} />, label: 'Notifications' },
      { id: 'ai', icon: <Sparkles size={16} />, label: 'AI & MCP' },
    ] },
    { label: s.workspace.name, items: [
      { id: 'workspace', icon: <Building2 size={16} />, label: 'General' },
      { id: 'members', icon: <Users size={16} />, label: 'Members' },
      { id: 'data', icon: <ArrowLeftRight size={16} />, label: 'Import & Export' },
      { id: 'calendars', icon: <CalendarDays size={16} />, label: 'Calendars' },
    ] },
  ];
  if (s.user.isAdmin) {
    groups.push({ label: 'Server', items: [
      { id: 'admin', icon: <ShieldCheck size={16} />, label: 'Administration' },
      { id: 'backups', icon: <DatabaseBackup size={16} />, label: 'Backups' },
      { id: 'mail', icon: <Mail size={16} />, label: 'Email' },
    ] });
  }

  const body = (
    <>
      {section === 'account' && <Account />}
      {section === 'appearance' && <Appearance />}
      {section === 'notifications' && <NotificationsSection />}
      {section === 'ai' && <AiSection />}
      {section === 'workspace' && <WorkspaceSection manages={manages} onClose={onClose} />}
      {section === 'members' && <MembersSection manages={manages} />}
      {section === 'data' && <DataSection onClose={onClose} />}
      {section === 'calendars' && <CalendarsSection />}
      {section === 'admin' && s.user.isAdmin && <AdminSection />}
      {section === 'backups' && s.user.isAdmin && <BackupsSection />}
      {section === 'mail' && s.user.isAdmin && <MailSection />}
    </>
  );

  if (phone) {
    return (
      <Modal onClose={onClose} className="settings st-phone" label="Settings">
        <div className="st-topbar">
          {listing
            ? <span className="st-topbar-title">Settings</span>
            : <button className="btn ghost st-back" onClick={() => setListing(true)}><ChevronLeft size={18} aria-hidden />Settings</button>}
          <button className="icon-btn st-close" aria-label="Close settings" onClick={onClose}><X size={20} /></button>
        </div>
        {listing ? (
          <nav className="st-phone-list" aria-label="Settings sections">
            {groups.map((g) => (
              <div key={g.label} className="st-phone-group">
                <div className="st-phone-head">{g.label}</div>
                <div className="st-phone-items">
                  {g.items.map((i) => (
                    <button key={i.id} className="st-phone-item" onClick={() => { onSection(i.id); setListing(false); }}>
                      {i.icon}<span className="grow">{i.label}</span><ChevronRight size={18} aria-hidden />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        ) : <div className="settings-body" key={section}>{body}</div>}
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} className="settings" label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {groups.map((g, gi) => (
          <div key={g.label}>
            <div className={`side-head${gi === 0 ? ' st-first' : ''}`}>{g.label}</div>
            {g.items.map((i) => (
              <button key={i.id} className={`side-item${section === i.id ? ' active' : ''}`} onClick={() => onSection(i.id)} aria-current={section === i.id ? 'page' : undefined}>{i.icon}{i.label}</button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-body" key={section}>
        <button className="icon-btn st-close-desk" aria-label="Close settings" onClick={onClose}><X size={18} /></button>
        {body}
      </div>
    </Modal>
  );
}

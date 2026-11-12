import { FilePlus2, Search, Sparkles, Table2 } from 'lucide-react';
import { useShell } from '../../Shell.tsx';

function greeting(hour: number) {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function WelcomeWidget() {
  const s = useShell();
  return (
    <div className="hm-welcome">
      <h1>{greeting(new Date().getHours())}, {s.user.name.split(' ')[0]}</h1>
      <p className="lead">{s.workspace.name}</p>
      <div className="quick">
        {s.canEdit && <button className="btn primary large" onClick={() => s.createPage({})}><FilePlus2 size={17} />New Page</button>}
        {s.canEdit && <button className="btn large" onClick={() => s.createPage({ kind: 'database' })}><Table2 size={17} />New Database</button>}
        <button className="btn large" onClick={s.openPalette}><Search size={17} />Search</button>
        <button className="btn large" onClick={() => s.openSettings('ai')}><Sparkles size={17} />Connect AI</button>
      </div>
    </div>
  );
}

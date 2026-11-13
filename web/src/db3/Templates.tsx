import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, FilePlus2, FileText, LayoutTemplate, MoreHorizontal, Pencil, Plus, Star, StarOff, Trash2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Page, TemplateSummary, Visibility } from '../../../shared/types.ts';
import { del, get, invalidateWorkspace, patch, post, qc } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { MenuItem, Modal, Popover, useUi } from '../ui.tsx';
import type { Db } from '../db/kit.tsx';
import './db3.css';

const useDbTemplates = (dbId: string) =>
  useQuery({ queryKey: ['templates', dbId], queryFn: () => get<TemplateSummary[]>(`/api/pages/${dbId}/templates`), staleTime: 30_000 });
const usePageTemplates = (wid: string, enabled = true) =>
  useQuery({
    queryKey: ['templates', 'ws', wid], enabled,
    queryFn: async () => (await get<TemplateSummary[]>(`/api/workspaces/${wid}/templates`)).filter((t) => t.kind === 'page'), staleTime: 30_000,
  });
const refreshTemplates = () => qc.invalidateQueries({ queryKey: ['templates'] });

/** Prints the current page; the database view's print CSS lays tables and boards out for paper. */
export function printView() {
  // Let the menu close before the print dialog freezes the page.
  setTimeout(() => {
    document.body.classList.add('d3-printing');
    const done = () => { document.body.classList.remove('d3-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  }, 80);
}

/** The database's "New" split button: the main part adds a row (default template applies); the arrow lists templates. */
export function NewRowButton({ db, onBlank }: { db: Db; onBlank: () => void }) {
  const ui = useUi();
  const navigate = useNavigate();
  const q = useDbTemplates(db.page.id);
  const list = q.data ?? [];
  const [manage, setManage] = useState<string | null>(null);
  const focusRow = (id: string) => setTimeout(() => (document.querySelector(`[data-row="${id}"] input`) as HTMLInputElement | null)?.focus(), 30);

  const fromTemplate = async (t: TemplateSummary) => {
    const row = await db.addRow({}, t.id);
    if (row) navigate(db.rowHref(row.id));
  };
  const blank = async () => { const row = await db.addRow({}, null); if (row) focusRow(row.id); };
  const newTemplate = async () => {
    try {
      const t = await post<Page>(`/api/workspaces/${db.wid}/pages`, { kind: 'row', parentId: db.page.id, isTemplate: true, title: '', templateId: null });
      refreshTemplates();
      navigate(db.rowHref(t.id));
    } catch (err) { ui.toast((err as Error).message); }
  };
  const setDefault = async (t: TemplateSummary | null) => {
    try {
      await patch(`/api/pages/${db.page.id}`, { defaultTemplateId: t?.id ?? null });
      refreshTemplates(); qc.invalidateQueries({ queryKey: ['page', db.page.id] });
      ui.toast(t ? `New rows now start from “${t.title || 'Untitled'}”` : 'New rows now start blank');
    } catch (err) { ui.toast((err as Error).message); }
  };
  const remove = async (t: TemplateSummary) => {
    const ok = await ui.confirm({ title: `Delete the template “${t.title || 'Untitled'}”?`, body: 'Rows already made from it stay as they are. You can restore it from Trash.', action: 'Delete Template', danger: true });
    if (!ok) return;
    try { await del(`/api/pages/${t.id}`); refreshTemplates(); qc.invalidateQueries({ queryKey: ['page', db.page.id] }); } catch (err) { ui.toast((err as Error).message); }
  };
  const def = list.find((t) => t.isDefault);

  return (
    <div className="d3-newsplit">
      <button className="btn primary small db-new" aria-label={def ? `New row from ${def.title || 'Untitled'}` : 'New row'} title={def ? `New row from “${def.title || 'Untitled'}”` : undefined} onClick={onBlank}>
        <Plus size={15} /><span>New</span>
      </button>
      <Popover placement="bottom-end" onOpenChange={(o) => { if (!o) setManage(null); }} trigger={(p) => (
        <button className="btn primary small d3-newmore" aria-label="More ways to add a row" title="Templates" {...p}><ChevronDown size={14} /></button>
      )}>
        <div className="d3-tmenu">
          <MenuItem icon={<FilePlus2 size={16} />} onClick={blank}>New Blank Row</MenuItem>
          {list.length > 0 && <div className="menu-label">Templates</div>}
          {list.map((t) => (
            <div key={t.id} className="d3-trow">
              <div className="d3-tline">
                <MenuItem icon={<span className="d3-ticon" aria-hidden>{t.icon || <FileText size={15} />}</span>} hint={t.isDefault ? 'Default' : undefined} onClick={() => fromTemplate(t)}>
                  {t.title || 'Untitled'}
                </MenuItem>
                <button type="button" className="icon-btn d3-tmore" aria-expanded={manage === t.id} aria-label={`Options for ${t.title || 'Untitled'}`} onClick={() => setManage(manage === t.id ? null : t.id)}>
                  <MoreHorizontal size={16} />
                </button>
              </div>
              {manage === t.id && (
                <div className="d3-tsub">
                  <MenuItem icon={<Pencil size={15} />} onClick={() => navigate(db.rowHref(t.id))}>Edit Template</MenuItem>
                  {t.isDefault
                    ? <MenuItem icon={<StarOff size={15} />} onClick={() => setDefault(null)}>Stop Using as Default</MenuItem>
                    : <MenuItem icon={<Star size={15} />} onClick={() => setDefault(t)}>Use for New Rows</MenuItem>}
                  <MenuItem danger icon={<Trash2 size={15} />} onClick={() => remove(t)}>Delete Template</MenuItem>
                </div>
              )}
            </div>
          ))}
          <div className="menu-sep" />
          <MenuItem icon={<LayoutTemplate size={16} />} onClick={newTemplate}>New Template</MenuItem>
        </div>
      </Popover>
    </div>
  );
}

/** "Editing template" strip shown on template pages and rows. */
export function TemplateBanner({ page }: { page: Page }) {
  const navigate = useNavigate();
  const s = useShell();
  if (!page.isTemplate) return null;
  const back = () => (page.kind === 'row' && page.parentId ? navigate(`/w/${s.wid}/p/${page.parentId}`) : navigate(-1));
  return (
    <div className="d3-banner" role="note">
      <LayoutTemplate size={16} />
      <span className="grow">
        <b>Editing template.</b>{' '}
        <span className="muted">
          {page.kind === 'row' ? 'New rows made from it copy its properties and content.' : 'New pages made from it copy its content.'}
          {' '}<code>{'{{date}}'}</code> becomes the day it’s used.
        </span>
      </span>
      <button className="btn small" onClick={back}><Check size={14} />Done</button>
    </div>
  );
}

/** "Save as template" from the page menu. */
export async function saveAsTemplate(page: Page, toast: (t: string, undo?: () => void) => void) {
  try {
    await post<Page>(`/api/pages/${page.id}/save-as-template`, {});
    refreshTemplates();
    toast(page.kind === 'row' ? 'Saved as a template. Find it under the arrow next to New.' : 'Saved as a template. Use it from New Page → From Template.');
  } catch (err) { toast((err as Error).message); }
}

// ---------- Page template picker (opened from the sidebar and phone "New" menus) ----------
type PickReq = { parentId: string | null; visibility?: Visibility } | null;
let pick: PickReq = null;
const subs = new Set<() => void>();
export function openTemplatePicker(opts: { parentId?: string | null; visibility?: Visibility }) { pick = { parentId: opts.parentId ?? null, visibility: opts.visibility }; subs.forEach((f) => f()); }
const closePicker = () => { pick = null; subs.forEach((f) => f()); };

/** Mounted once in the shell. */
export function TemplatePickerHost() {
  const r = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => pick);
  if (!r) return null;
  return <TemplatePicker req={r} />;
}

function TemplatePicker({ req }: { req: NonNullable<PickReq> }) {
  const s = useShell();
  const ui = useUi();
  const navigate = useNavigate();
  const q = usePageTemplates(s.wid);
  const list = q.data ?? [];
  const use = async (t: TemplateSummary) => {
    closePicker();
    await s.createPage({ parentId: req.parentId, visibility: req.visibility, templateId: t.id });
  };
  const remove = async (t: TemplateSummary) => {
    const ok = await ui.confirm({ title: `Delete the template “${t.title || 'Untitled'}”?`, body: 'Pages already made from it stay as they are.', action: 'Delete Template', danger: true });
    if (!ok) return;
    try { await del(`/api/pages/${t.id}`); refreshTemplates(); } catch (err) { ui.toast((err as Error).message); }
  };
  const newTemplate = async () => {
    try {
      const t = await post<Page>(`/api/workspaces/${s.wid}/pages`, { kind: 'page', isTemplate: true, title: '' });
      closePicker(); refreshTemplates(); invalidateWorkspace(s.wid);
      navigate(`/w/${s.wid}/p/${t.id}`);
    } catch (err) { ui.toast((err as Error).message); }
  };
  return (
    <Modal onClose={closePicker} label="New page from a template" className="modal d3-modal d3-picker">
      <h2>New Page from Template</h2>
      {q.isPending ? <div className="subtle">Loading…</div> : list.length === 0 ? (
        <div className="d3-pempty">
          <LayoutTemplate size={22} />
          <div><b>No page templates yet.</b><div className="muted">Make one here, or open any page and choose “Save as Template” from its ••• menu.</div></div>
        </div>
      ) : (
        <div className="d3-plist" role="list">
          {list.map((t) => (
            <div key={t.id} className="d3-pitem" role="listitem">
              <button type="button" className="d3-puse" onClick={() => use(t)}>
                <span className="d3-ticon big" aria-hidden>{t.icon || <FileText size={18} />}</span>
                <span className="grow clip">{t.title || 'Untitled'}</span>
              </button>
              <button type="button" className="icon-btn" aria-label={`Edit ${t.title || 'Untitled'}`} title="Edit template" onClick={() => { closePicker(); navigate(`/w/${s.wid}/p/${t.id}`); }}><Pencil size={15} /></button>
              <button type="button" className="icon-btn" aria-label={`Delete ${t.title || 'Untitled'}`} title="Delete template" onClick={() => remove(t)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn" onClick={newTemplate}><Plus size={15} />New Template</button>
        <span className="grow" />
        <button className="btn" onClick={closePicker}>Cancel</button>
      </div>
    </Modal>
  );
}

/** A quiet suggestion on a fresh, empty page: fill it from a page template. */
export function StartFromTemplate({ page, onApply }: { page: Page; onApply: (p: Page) => void }) {
  const s = useShell();
  const q = usePageTemplates(s.wid);
  const ui = useUi();
  const list = q.data ?? [];
  if (!list.length) return null;
  const apply = async (t: TemplateSummary) => {
    try {
      onApply(await post<Page>(`/api/pages/${page.id}/apply-template`, { templateId: t.id }));
    } catch (err) { ui.toast((err as Error).message); }
  };
  return (
    <div className="d3-startfrom">
      <Popover trigger={(p) => <button type="button" className="d3-startbtn" {...p}><LayoutTemplate size={15} />Start from a template</button>}>
        <div className="menu-label">Page templates</div>
        {list.map((t) => <MenuItem key={t.id} icon={<span className="d3-ticon" aria-hidden>{t.icon || <FileText size={15} />}</span>} onClick={() => apply(t)}>{t.title || 'Untitled'}</MenuItem>)}
      </Popover>
    </div>
  );
}

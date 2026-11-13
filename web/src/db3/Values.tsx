import { Bell, Check, File as FileIcon, Loader2, Paperclip, Repeat as RepeatIcon, Upload, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { Property, PropValue } from '../../../shared/types.ts';
import { api, uid } from '../api.ts';
import { Popover, useUi } from '../ui.tsx';
import { fileName, fmtNumber, isImage, resultKind } from './format.ts';
import './db3.css';

function fmtDay(v: string) {
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  if (isNaN(d.getTime())) return v;
  return v.length <= 10
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Read-only rendering of a rollup or formula result. `compact` is for cards. */
export function ComputedValue({ prop, value, compact }: { prop: Property; value: PropValue; compact?: boolean }) {
  const kind = resultKind(prop);
  if (value === null || value === undefined || value === '') return null;
  if (kind === 'list' || Array.isArray(value)) {
    const items = (Array.isArray(value) ? value : [String(value)]).filter((x) => x !== '');
    if (!items.length) return null;
    const max = compact ? 2 : 4;
    return (
      <span className="d3-list" title={items.join(', ')}>
        {items.slice(0, max).map((x, i) => <span key={i} className="chip d3-chip">{x}</span>)}
        {items.length > max && <span className="meta-text">+{items.length - max}</span>}
      </span>
    );
  }
  if (typeof value === 'boolean' || kind === 'checkbox') {
    const on = value === true;
    if (compact) return on ? <span className="meta-text" title={prop.name}><Check size={13} />{prop.name}</span> : null;
    return <span className={`d3-check${on ? ' on' : ''}`} role="img" aria-label={on ? 'Yes' : 'No'}>{on && <Check size={12} strokeWidth={3} />}</span>;
  }
  if (typeof value === 'number') {
    const text = fmtNumber(value, prop.numberFormat ?? (prop.rollup?.fn === 'percent_checked' ? 'percent' : 'plain'));
    return compact ? <span className="meta-text" title={prop.name}>{prop.name} {text}</span> : <span className="d3-num">{text}</span>;
  }
  if (kind === 'date') return compact ? <span className="meta-text" title={prop.name}>{prop.name} {fmtDay(String(value))}</span> : <span>{fmtDay(String(value))}</span>;
  return <span className={compact ? 'meta-text clip' : 'd3-text'} title={String(value)}>{String(value)}</span>;
}

/** Files as chips: a thumbnail for images, else an icon; the name opens the file. */
export function FilesView({ value, compact }: { value: PropValue; compact?: boolean }) {
  const urls = Array.isArray(value) ? value : [];
  if (!urls.length) return null;
  if (compact) return <span className="meta-text" title={urls.map(fileName).join(', ')}><Paperclip size={12} />{urls.length === 1 ? fileName(urls[0]) : `${urls.length} files`}</span>;
  return (
    <span className="d3-files">
      {urls.map((u) => (
        <a key={u} className="d3-file" href={u} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={fileName(u)}>
          {isImage(u) ? <img src={u} alt="" loading="lazy" /> : <FileIcon size={13} aria-hidden />}
          <span className="d3-file-n">{fileName(u)}</span>
        </a>
      ))}
    </span>
  );
}

/** Upload, open and remove the files of a files property. */
export function FilesEditor({ prop, value, wid, onChange }: { prop: Property; value: PropValue; wid: string; onChange: (v: PropValue) => void }) {
  const urls = Array.isArray(value) ? value : [];
  return (
    <Popover trigger={(p) => (
      <button type="button" className="cell" aria-label={`${prop.name}: ${urls.length ? `${urls.length} files` : 'no files'}`} {...p}>
        <FilesView value={urls} />
      </button>
    )}>
      <FilesPanel urls={urls} wid={wid} onChange={onChange} />
    </Popover>
  );
}

function FilesPanel({ urls, wid, onChange }: { urls: string[]; wid: string; onChange: (v: PropValue) => void }) {
  const ui = useUi();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const inputId = useRef(`d3f-${uid()}`).current;
  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setBusy(list.length);
    const added: string[] = [];
    for (const f of list) {
      const form = new FormData();
      form.append('file', f, f.name);
      try { added.push((await api<{ url: string }>('POST', `/api/workspaces/${wid}/files`, form)).url); }
      catch (err) { ui.toast(`Couldn’t upload ${f.name}: ${(err as Error).message}`); }
      setBusy((n) => n - 1);
    }
    if (added.length) onChange([...urls, ...added]);
  };
  return (
    <div
      className={`d3-fpanel${over ? ' over' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files); }}
    >
      {urls.length === 0 && <div className="subtle d3-fempty">No files yet. Upload or drop files here.</div>}
      {urls.map((u) => (
        <div key={u} className="d3-frow">
          <a className="d3-fthumb" href={u} target="_blank" rel="noopener noreferrer" aria-hidden tabIndex={-1}>
            {isImage(u) ? <img src={u} alt="" loading="lazy" /> : <FileIcon size={16} />}
          </a>
          <a className="d3-fname" href={u} target="_blank" rel="noopener noreferrer">{fileName(u)}</a>
          <button type="button" className="icon-btn" aria-label={`Remove ${fileName(u)}`} title="Remove from this property" onClick={() => onChange(urls.filter((x) => x !== u))}><X size={15} /></button>
        </div>
      ))}
      <input ref={input} id={inputId} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
      <button type="button" className="btn small d3-fup" disabled={busy > 0} onClick={() => input.current?.click()}>
        {busy > 0 ? <><Loader2 size={14} className="d3-spin" />Uploading{busy > 1 ? ` ${busy} files` : ''}…</> : <><Upload size={14} />Upload Files</>}
      </button>
    </div>
  );
}

/** A number input that shows its formatted value until focused. */
export function NumberInput({ prop, value, onChange }: { prop: Property; value: PropValue; onChange: (v: PropValue) => void }) {
  const raw = value === null || value === undefined ? '' : String(value);
  const shown = typeof value === 'number' ? fmtNumber(value, prop.numberFormat) : raw;
  return (
    <input
      key={`${raw}:${prop.numberFormat}`} className="cell-input d3-numin" defaultValue={shown} aria-label={prop.name} inputMode="decimal"
      onFocus={(e) => { e.currentTarget.value = raw; }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = raw; e.currentTarget.blur(); } }}
      onBlur={(e) => {
        const t = e.target.value.trim().replace(/[^\d.eE+-]/g, '');
        const next: PropValue = t === '' ? null : Number(t);
        if (next !== (value ?? null) && !(typeof next === 'number' && isNaN(next))) onChange(next);
        else e.target.value = shown;
      }}
    />
  );
}

/** Small marks next to a date: the row repeats, or has reminders. Rows only carry these when the server sends them. */
export function RowMarks({ row }: { row: { repeat?: unknown; reminders?: unknown[] } }): ReactNode {
  const rep = !!row.repeat;
  const rem = !!row.reminders?.length;
  if (!rep && !rem) return null;
  return (
    <>
      {rep && <span className="d3-mark" title="Repeats" aria-label="Repeats"><RepeatIcon size={12} /></span>}
      {rem && <span className="d3-mark" title="Has reminders" aria-label="Has reminders"><Bell size={12} /></span>}
    </>
  );
}

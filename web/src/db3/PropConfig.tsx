import { useQueries } from '@tanstack/react-query';
import { AlertCircle, ArrowLeftRight, BookOpen, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { computeRows } from '../../../shared/compute.ts';
import { parseFormula } from '../../../shared/formula.ts';
import type { Filter, Page, Property, PropertyType, RollupConfig, RollupFn } from '../../../shared/types.ts';
import { get, uid } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { Modal } from '../ui.tsx';
import { PropIcon, type Db } from '../db/kit.tsx';
import { FilterList } from '../db/menus.tsx';
import { effectiveType, isComputed, NUMBER_FORMATS, resultKind, ROLLUP_FNS } from './format.ts';
import { ComputedValue } from './Values.tsx';

// ---------- A tiny store so menus (which close) can open the editor that lives with the database view ----------
type Req = { dbId: string; draft: Property; isNew: boolean } | null;
let req: Req = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export function openPropConfig(dbId: string, draft: Property, isNew: boolean) { req = { dbId, draft, isNew }; emit(); }
const closeReq = () => { req = null; emit(); };
const useReq = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => req);

export function newPropertyDraft(type: 'rollup' | 'formula', db: Db): Property {
  const n = db.schema.filter((p) => p.type === type).length;
  const base = type === 'rollup' ? 'Rollup' : 'Formula';
  return { id: uid(), name: n ? `${base} ${n + 1}` : base, type };
}

export function configLabel(prop: Property, _db: Db): string {
  return prop.type === 'rollup' ? 'Edit Rollup…' : 'Edit Formula…';
}

/** Mounted once per database view: shows the rollup / formula editor when asked. */
export function PropConfigHost({ db }: { db: Db }) {
  const r = useReq();
  if (!r || r.dbId !== db.page.id) return null;
  const save = (p: Property) => {
    db.setSchema(r.isNew || !db.schema.some((x) => x.id === p.id) ? [...db.schema, p] : db.schema.map((x) => (x.id === p.id ? p : x)));
    closeReq();
  };
  return r.draft.type === 'rollup'
    ? <RollupEditor key={r.draft.id} db={db} draft={r.draft} isNew={r.isNew} onSave={save} onClose={closeReq} />
    : <FormulaEditor key={r.draft.id} db={db} draft={r.draft} isNew={r.isNew} onSave={save} onClose={closeReq} />;
}

// ---------- Rollup ----------
interface Source { key: string; label: string; detail: string; dbId: string; source: RollupConfig['source'] }

function useWorkspaceDatabases(): { id: string; title: string; icon: string; schema: Property[] | undefined }[] {
  const s = useShell();
  const nodes = (s.tree?.nodes ?? []).filter((n) => n.kind === 'database');
  const results = useQueries({ queries: nodes.map((n) => ({ queryKey: ['page', n.id], queryFn: () => get<Page>(`/api/pages/${n.id}`), staleTime: 30_000 })) });
  return nodes.map((n, i) => ({ id: n.id, title: n.title || 'Untitled', icon: n.icon, schema: results[i].data?.schema }));
}

function RollupEditor({ db, draft, isNew, onSave, onClose }: { db: Db; draft: Property; isNew: boolean; onSave: (p: Property) => void; onClose: () => void }) {
  const dbs = useWorkspaceDatabases();
  const title = (id: string | undefined) => dbs.find((d) => d.id === id)?.title ?? 'another database';
  const sources: Source[] = useMemo(() => {
    const out: Source[] = db.schema.filter((p) => p.type === 'relation' && p.relationDatabaseId).map((p) => ({
      key: `r:${p.id}`, label: p.name, detail: `Rows this ${db.page.title || 'row'} links to in ${title(p.relationDatabaseId)}`, dbId: p.relationDatabaseId!, source: { kind: 'relation', propertyId: p.id },
    }));
    for (const d of dbs) for (const q of d.schema ?? []) {
      if (q.type === 'relation' && q.relationDatabaseId === db.page.id) {
        out.push({ key: `i:${d.id}:${q.id}`, label: `${d.title} → ${q.name}`, detail: `Rows in ${d.title} whose ${q.name} is this row`, dbId: d.id, source: { kind: 'incoming', databaseId: d.id, propertyId: q.id } });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db.schema, dbs.map((d) => `${d.id}:${d.schema?.length ?? -1}`).join()]);
  const keyOf = (src: RollupConfig['source'] | undefined) => !src ? '' : src.kind === 'relation' ? `r:${src.propertyId}` : `i:${src.databaseId}:${src.propertyId}`;

  const [name, setName] = useState(draft.name);
  const [srcKey, setSrcKey] = useState(keyOf(draft.rollup?.source));
  const [target, setTarget] = useState(draft.rollup?.target ?? 'title');
  const [fn, setFn] = useState<RollupFn>(draft.rollup?.fn ?? 'count');
  const [filters, setFilters] = useState<Filter[]>(draft.rollup?.filters ?? []);
  const [format, setFormat] = useState(draft.numberFormat ?? 'plain');
  const src = sources.find((x) => x.key === srcKey) ?? (srcKey ? undefined : sources[0]);
  const related = src ? dbs.find((d) => d.id === src.dbId)?.schema ?? (src.dbId === db.page.id ? db.schema : undefined) : undefined;
  const targets = (related ?? []).filter((p) => p.id !== draft.id);
  const targetProp = targets.find((p) => p.id === target);
  const tType: PropertyType | 'title' = target === 'title' ? 'title' : targetProp ? effectiveType(targetProp) : 'text';
  const fns = ROLLUP_FNS.filter((f) => f.fits(tType));
  const fnOk = fns.some((f) => f.fn === fn) ? fn : 'count';
  const numeric = !['show', 'earliest', 'latest'].includes(fnOk);
  const ready = !!src && (target === 'title' || !!targetProp) && name.trim();

  const save = () => {
    if (!src) return;
    const rollup: RollupConfig = { source: src.source, target, fn: fnOk, ...(filters.length ? { filters } : {}) };
    onSave({ id: draft.id, name: name.trim(), type: 'rollup', rollup, ...(numeric && format !== 'plain' ? { numberFormat: format } : {}) });
  };

  return (
    <Modal onClose={onClose} label={isNew ? 'New rollup' : 'Edit rollup'} className="modal d3-modal">
      <h2>{isNew ? 'New Rollup' : 'Edit Rollup'}</h2>
      <p className="muted d3-lede">Sum up values from related rows, like the number of open tasks in a project.</p>
      <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Related rows</span>
        {sources.length ? (
          <select className="select" value={src?.key ?? ''} onChange={(e) => { setSrcKey(e.target.value); setTarget('title'); setFilters([]); }}>
            {!src && <option value="">Choose…</option>}
            {sources.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        ) : <span className="d3-note"><ArrowLeftRight size={15} />Add a relation property here, or relate another database to this one, first.</span>}
        {src && <small className="subtle">{src.detail}</small>}
      </label>
      {src && (
        <div className="d3-two">
          <label className="field"><span>Property</span>
            <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!related}>
              <option value="title">Name</option>
              {targets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Calculate</span>
            <select className="select" value={fnOk} onChange={(e) => setFn(e.target.value as RollupFn)}>
              {fns.map((f) => <option key={f.fn} value={f.fn}>{f.label}</option>)}
            </select>
          </label>
        </div>
      )}
      {src && related && (
        <div className="field">
          <span>Only rows where</span>
          <div className="d3-filters"><FilterList filters={filters} schema={related.filter((p) => p.id !== draft.id)} canEdit onChange={setFilters} empty="All related rows count. Add a filter to count only some, like Status is not Done." /></div>
        </div>
      )}
      {src && numeric && (
        <label className="field"><span>Number format</span>
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            {NUMBER_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}{f.sample ? ` (${f.sample})` : ''}</option>)}
          </select>
        </label>
      )}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ready} onClick={save}>{isNew ? 'Add Rollup' : 'Save Rollup'}</button>
      </div>
    </Modal>
  );
}

// ---------- Formula ----------
const FN_REF: [string, string][] = [
  ['prop("Name")', 'Value of a property'], ['if(cond, a, b)', 'a when cond is true, else b'], ['empty(x)', 'True when x has no value'],
  ['concat(a, b, …)', 'Join text'], ['length(text)', 'Number of characters'], ['contains(text, part)', 'True when text includes part'],
  ['lower(text) · upper(text)', 'Change case'], ['round(n, digits)', 'Round a number'], ['floor · ceil · abs', 'Number helpers'],
  ['min(…) · max(…)', 'Smallest or largest'], ['today() · now()', 'Current date or time'],
  ['dateAdd(date, n, "days")', 'Move a date forward'], ['dateSubtract(date, n, "weeks")', 'Move a date back'],
  ['dateBetween(a, b, "days")', 'a − b in whole units'], ['formatDate(date, "short")', '"12 Nov 2026" or "iso"'],
  ['year · month · day · weekday', 'Parts of a date (weekday 0 = Sunday)'], ['toNumber(x) · format(x)', 'Convert to number or text'],
  ['+ − * / %', 'Arithmetic; + also joins text'], ['== != > < >= <=', 'Compare'], ['and · or · not', 'Logic'],
];

function FormulaEditor({ db, draft, isNew, onSave, onClose }: { db: Db; draft: Property; isNew: boolean; onSave: (p: Property) => void; onClose: () => void }) {
  const [name, setName] = useState(draft.name);
  const [expr, setExpr] = useState(draft.formula?.expression ?? '');
  const [format, setFormat] = useState(draft.numberFormat ?? 'plain');
  const [ref, setRef] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const others = db.schema.filter((p) => p.id !== draft.id);
  const parsed = useMemo(() => (expr.trim() ? parseFormula(expr, [...others, { ...draft, formula: { expression: expr } }]) : null), [expr, others, draft]);
  const resultType = parsed?.ok ? parsed.resultType : undefined;
  const live: Property = { ...draft, name: name.trim() || draft.name, type: 'formula', formula: { expression: expr, resultType }, numberFormat: format };

  // Preview the draft on the first rows. Other computed columns keep the values the server sent, so only the draft runs here.
  const preview = useMemo(() => {
    if (!parsed?.ok) return [];
    const frozen: Property[] = others.map((p) => {
      if (!isComputed(p)) return p;
      const k = resultKind(p);
      return { id: p.id, name: p.name, type: k === 'list' ? 'text' : (k ?? 'text') } as Property;
    });
    const rows = db.rows.slice(0, 4);
    try {
      return computeRows(rows, [...frozen, live], {
        getRows: () => [], getSchema: () => [], today: new Date().toLocaleDateString('en-CA'), now: new Date(),
        getPersonName: (id) => db.users.find((u) => u.id === id)?.name ?? '',
      }).map((r) => ({ id: r.id, title: r.title, value: r.props[draft.id] ?? null }));
    } catch { return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, db.rows, others, format]);

  const insert = (text: string) => {
    const el = area.current;
    const a = el?.selectionStart ?? expr.length, b = el?.selectionEnd ?? expr.length;
    const next = expr.slice(0, a) + text + expr.slice(b);
    setExpr(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + text.length, a + text.length); });
  };
  const ok = !!parsed?.ok && !!name.trim();
  const err = parsed && !parsed.ok ? parsed : null;

  return (
    <Modal onClose={onClose} label={isNew ? 'New formula' : 'Edit formula'} className="modal d3-modal wide">
      <h2>{isNew ? 'New Formula' : 'Edit Formula'}</h2>
      <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Expression</span>
        <textarea
          ref={area} className={`input d3-expr${err ? ' bad' : ''}`} value={expr} rows={3} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          placeholder={'if(prop("Status") == "Done", "✓", "")'} aria-invalid={!!err} aria-describedby="d3-expr-status"
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ok) { e.preventDefault(); onSave({ ...live, ...(resultType === 'number' && format !== 'plain' ? {} : { numberFormat: undefined }) }); } }}
        />
      </label>
      <div id="d3-expr-status" className="d3-status" aria-live="polite">
        {!parsed && <span className="subtle">Write an expression. Insert properties below.</span>}
        {err && (
          <div className="d3-err">
            <AlertCircle size={15} /><span>{err.message} <span className="subtle">at character {err.at + 1}</span></span>
            <code className="d3-errline">{expr.slice(Math.max(0, err.at - 30), err.at)}<mark>{expr.slice(err.at, err.at + 1) || ' '}</mark>{expr.slice(err.at + 1, err.at + 20)}</code>
          </div>
        )}
        {parsed?.ok && <span className="d3-okline">Result: <b>{{ number: 'Number', text: 'Text', checkbox: 'Checkbox', date: 'Date' }[parsed.resultType]}</b></span>}
      </div>
      <div className="d3-insert" aria-label="Insert a property">
        <button type="button" className="d3-pill" onClick={() => insert('prop("Name")')}><PropIcon type="title" size={13} />Name</button>
        {others.map((p) => <button type="button" key={p.id} className="d3-pill" onClick={() => insert(`prop("${p.name.replace(/"/g, '\\"')}")`)}><PropIcon type={p.type} size={13} />{p.name}</button>)}
      </div>
      <button type="button" className="btn ghost small d3-reftoggle" aria-expanded={ref} onClick={() => setRef(!ref)}>
        <BookOpen size={14} />Functions<ChevronRight size={14} style={{ transform: ref ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }} />
      </button>
      {ref && (
        <dl className="d3-ref">
          {FN_REF.map(([f, d]) => <div key={f}><dt><code>{f}</code></dt><dd>{d}</dd></div>)}
        </dl>
      )}
      {parsed?.ok && preview.length > 0 && (
        <div className="d3-preview">
          <div className="d3-prev-h">Preview</div>
          {preview.map((r) => (
            <div key={r.id} className="d3-prev-row">
              <span className="clip">{r.title || 'Untitled'}</span>
              <span className="d3-prev-v">{r.value === null || r.value === '' ? <span className="subtle">empty</span> : <ComputedValue prop={live} value={r.value} />}</span>
            </div>
          ))}
        </div>
      )}
      {resultType === 'number' && (
        <label className="field"><span>Number format</span>
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            {NUMBER_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}{f.sample ? ` (${f.sample})` : ''}</option>)}
          </select>
        </label>
      )}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ok} onClick={() => onSave({ id: draft.id, name: name.trim(), type: 'formula', formula: { expression: expr, resultType }, ...(resultType === 'number' && format !== 'plain' ? { numberFormat: format } : {}) })}>
          {isNew ? 'Add Formula' : 'Save Formula'}
        </button>
      </div>
    </Modal>
  );
}

import { BarChart3 } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import type { ChartConfig, OptionColor, Property, Row } from '../../../shared/types.ts';
import type { Db } from './kit.tsx';
import './views.css';

type Group = { key: string; label: string; color: OptionColor; value: number };
type Summary = { title: string; headline: string; headlineLabel: string; groups: Group[]; valueName: string };

const PALETTE: OptionColor[] = ['blue', 'green', 'orange', 'purple', 'teal', 'pink', 'yellow', 'brown', 'red'];
const NONE = '';
const fill = (c: OptionColor) => `var(--o-${c}-fg)`;
const fmt = (n: number, avg = false) => n.toLocaleString(undefined, { maximumFractionDigits: avg ? 2 : 1 });
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

/** Which groups a row falls in. Multi-value properties put a row in several groups. */
function keysOf(row: Row, by: Property | 'createdAt'): string[] {
  if (by === 'createdAt') return [row.createdAt.slice(0, 7)];
  const v = row.props[by.id];
  switch (by.type) {
    case 'checkbox': return [v ? 'yes' : 'no'];
    case 'date': return [typeof v === 'string' && /^\d{4}-\d{2}/.test(v) ? v.slice(0, 7) : NONE];
    case 'multi_select': case 'person': case 'relation': return Array.isArray(v) && v.length ? v : [NONE];
    default: return v ? [String(v)] : [NONE];
  }
}

/** Every month from the first to the last key, so a line has no hidden gaps. */
function monthRange(keys: string[]): string[] {
  const sorted = keys.filter(Boolean).sort();
  if (!sorted.length) return [];
  const out: string[] = [];
  let [y, m] = sorted[0].split('-').map(Number);
  const last = sorted[sorted.length - 1];
  for (let ym = sorted[0]; ym <= last; ym = `${y}-${String(m).padStart(2, '0')}`) {
    out.push(ym);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The groups in their natural order, with labels and colours. */
function groupOrder(db: Db, by: Property | 'createdAt', seen: string[]): { key: string; label: string; color?: OptionColor }[] {
  const none = { key: NONE, label: 'None', color: 'gray' as OptionColor };
  if (by === 'createdAt' || by.type === 'date') return [...monthRange(seen).map((k) => ({ key: k, label: monthLabel(k) })), none];
  switch (by.type) {
    case 'select': case 'status': case 'multi_select':
      return [...(by.options ?? []).map((o) => ({ key: o.id, label: o.name, color: o.color })), none];
    case 'checkbox': return [{ key: 'yes', label: 'Checked', color: 'green' }, { key: 'no', label: 'Unchecked', color: 'gray' }];
    case 'person': return [...seen.filter(Boolean).map((id) => ({ key: id, label: db.users.find((u) => u.id === id)?.name ?? 'Former member' })).sort((a, b) => a.label.localeCompare(b.label)), none];
    case 'relation': return [...seen.filter(Boolean).map((id) => ({ key: id, label: db.relTitles.get(id) ?? 'Untitled' })).sort((a, b) => a.label.localeCompare(b.label)), none];
    default: return [...seen.filter(Boolean).map((k) => ({ key: k, label: k })), none];
  }
}

function summarise(db: Db, cfg: ChartConfig): Summary | null {
  const by = cfg.groupBy === 'createdAt' ? 'createdAt' : db.schema.find((p) => p.id === cfg.groupBy);
  if (!by) return null;
  const valueProp = cfg.measure === 'count' ? undefined : db.schema.find((p) => p.id === cfg.valueProp && p.type === 'number');
  const measure = valueProp ? cfg.measure : 'count';
  const num = (r: Row) => { const v = valueProp ? r.props[valueProp.id] : null; return typeof v === 'number' && isFinite(v) ? v : null; };

  const acc = new Map<string, { sum: number; n: number }>();
  for (const row of db.shown) {
    const v = num(row);
    if (measure !== 'count' && v === null) continue;
    for (const k of keysOf(row, by)) {
      const a = acc.get(k) ?? { sum: 0, n: 0 };
      a.sum += v ?? 0; a.n += 1;
      acc.set(k, a);
    }
  }
  // Options and months keep their empty groups (a zero is information there); "None" only shows when used.
  const keepEmpty = by === 'createdAt' || ['select', 'status', 'multi_select', 'checkbox', 'date'].includes(by.type);
  let cycle = 0;
  const groups = groupOrder(db, by, [...acc.keys()])
    .filter((g) => acc.has(g.key) || (keepEmpty && g.key !== NONE))
    .map((g) => {
      const a = acc.get(g.key) ?? { sum: 0, n: 0 };
      const value = measure === 'count' ? a.n : measure === 'sum' ? a.sum : a.n ? a.sum / a.n : 0;
      return { key: g.key, label: g.label, value, color: g.color ?? PALETTE[cycle++ % PALETTE.length] };
    });

  const byName = by === 'createdAt' ? 'Month Created' : by.name;
  const values = db.shown.map(num).filter((v): v is number => v !== null);
  const total = values.reduce((s, v) => s + v, 0);
  if (measure === 'count') {
    return { title: `Rows by ${byName}`, headline: fmt(db.shown.length), headlineLabel: db.shown.length === 1 ? 'row' : 'rows', groups, valueName: 'Rows' };
  }
  const name = valueProp!.name;
  return measure === 'sum'
    ? { title: `Total ${name} by ${byName}`, headline: fmt(total), headlineLabel: `total ${name}`, groups, valueName: `Total ${name}` }
    : { title: `Average ${name} by ${byName}`, headline: fmt(values.length ? total / values.length : 0, true), headlineLabel: `average ${name}`, groups, valueName: `Average ${name}` };
}

/** Width of an element, kept current, so the SVG draws at real pixels and its text stays readable. */
function useWidth() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(Math.floor(el.clientWidth));
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

/** Shorten a label to roughly fit a pixel width at 13px. */
const clip = (s: string, px: number) => { const max = Math.max(3, Math.floor(px / 7)); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export function ChartView({ db }: { db: Db }) {
  const [ref, width] = useWidth();
  const cfg = db.view.chart;
  const data = cfg ? summarise(db, cfg) : null;

  if (!cfg || !data) return <div className="empty"><BarChart3 size={22} />Choose what to group by in the view menu.</div>;
  if (!db.shown.length) return <div className="empty"><BarChart3 size={22} />No rows{db.rows.length ? ' match this view' : ' yet'}, so there is nothing to chart.</div>;

  const avg = cfg.measure === 'avg';
  const describe = `${data.title}. ${data.groups.map((g) => `${g.label}: ${fmt(g.value, avg)}`).join('; ')}.`;
  return (
    <figure className="ch">
      <figcaption className="ch-head">
        <span className="ch-title">{data.title}</span>
        <span className="ch-headline"><b>{data.headline}</b> {data.headlineLabel}</span>
      </figcaption>
      <div className="ch-plot" ref={ref}>
        {width > 0 && (cfg.kind === 'donut' ? <Donut groups={data.groups} width={width} avg={avg} label={describe} centre={data.headline} centreLabel={data.headlineLabel} />
          : cfg.kind === 'line' ? <Line groups={data.groups.filter((g) => g.key !== NONE)} width={width} avg={avg} label={describe} />
          : <Bars groups={data.groups} width={width} avg={avg} label={describe} />)}
      </div>
      <details className="ch-data">
        <summary>Show Data</summary>
        <table className="ch-table">
          <thead><tr><th scope="col">Group</th><th scope="col">{data.valueName}</th></tr></thead>
          <tbody>{data.groups.map((g) => <tr key={g.key}><th scope="row">{g.label}</th><td>{fmt(g.value, avg)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

type PlotProps = { groups: Group[]; width: number; avg: boolean; label: string };

function Bars({ groups, width, avg, label }: PlotProps) {
  const rowH = 34, barH = 20;
  const labelW = Math.min(180, Math.round(width * 0.32));
  const valueW = 64;
  const plotW = Math.max(40, width - labelW - valueW - 12);
  const max = Math.max(...groups.map((g) => g.value), 0) || 1;
  const height = groups.length * rowH;
  return (
    <svg className="ch-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {groups.map((g, i) => {
        const y = i * rowH;
        const w = g.value > 0 ? Math.max(2, (g.value / max) * plotW) : 0;
        return (
          <g key={g.key}>
            <title>{`${g.label}: ${fmt(g.value, avg)}`}</title>
            <text className="ch-label" x={labelW - 10} y={y + rowH / 2} textAnchor="end" dominantBaseline="central">{clip(g.label, labelW - 12)}</text>
            <rect className="ch-track" x={labelW} y={y + (rowH - barH) / 2} width={plotW} height={barH} rx={5} />
            {w > 0 && <rect x={labelW} y={y + (rowH - barH) / 2} width={w} height={barH} rx={5} fill={fill(g.color)} />}
            <text className="ch-value" x={labelW + w + 8} y={y + rowH / 2} dominantBaseline="central">{fmt(g.value, avg)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => `${cx + r * Math.sin(a)} ${cy - r * Math.cos(a)}`;
  return `M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`;
}

function Donut({ groups, width, avg, label, centre, centreLabel }: PlotProps & { centre: string; centreLabel: string }) {
  const size = Math.min(240, width);
  const stroke = Math.round(size * 0.16);
  const r = (size - stroke) / 2 - 2;
  const c = size / 2;
  const shown = groups.filter((g) => g.value > 0);
  const total = shown.reduce((s, g) => s + g.value, 0) || 1;
  const gap = shown.length > 1 ? 0.025 : 0;
  let a = 0;
  return (
    <div className="ch-donut">
      <svg className="ch-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle className="ch-ring" cx={c} cy={c} r={r} strokeWidth={stroke} />
        {shown.map((g) => {
          const a0 = a, a1 = a + (g.value / total) * Math.PI * 2;
          a = a1;
          const path = shown.length === 1
            ? <circle cx={c} cy={c} r={r} fill="none" stroke={fill(g.color)} strokeWidth={stroke} />
            : <path d={arc(c, c, r, a0 + gap / 2, a1 - gap / 2)} fill="none" stroke={fill(g.color)} strokeWidth={stroke} />;
          return <g key={g.key}><title>{`${g.label}: ${fmt(g.value, avg)}`}</title>{path}</g>;
        })}
        <text className="ch-centre" x={c} y={c - 4} textAnchor="middle">{centre}</text>
        <text className="ch-centre-l" x={c} y={c + 16} textAnchor="middle">{centreLabel}</text>
      </svg>
      <ul className="ch-legend">
        {groups.map((g) => (
          <li key={g.key}>
            <span className="ch-swatch" style={{ background: fill(g.color) }} aria-hidden />
            <span className="ch-legend-l">{g.label}</span>
            <span className="ch-legend-v">{fmt(g.value, avg)}</span>
            {!avg && <span className="ch-legend-p">{Math.round((g.value / total) * 100)}%</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Round numbers for a value axis: 0 … a tidy maximum, in about four steps (whole steps for whole numbers). */
function ticks(max: number, whole: boolean) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw && (!whole || (s >= 1 && Number.isInteger(s))))!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function Line({ groups, width, avg, label }: PlotProps) {
  const height = 260;
  const pad = { l: 48, r: 16, t: 14, b: 32 };
  const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
  const ys = ticks(Math.max(...groups.map((g) => g.value), 0), groups.every((g) => Number.isInteger(g.value)));
  const top = ys[ys.length - 1] || 1;
  const step = groups.length > 1 ? plotW / (groups.length - 1) : 0;
  const px = (i: number) => pad.l + (groups.length > 1 ? i * step : plotW / 2);
  const py = (v: number) => pad.t + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil((groups.length * 72) / Math.max(plotW, 1)));
  const line = groups.map((g, i) => `${i ? 'L' : 'M'} ${px(i)} ${py(g.value)}`).join(' ');
  const area = groups.length ? `${line} L ${px(groups.length - 1)} ${py(0)} L ${px(0)} ${py(0)} Z` : '';
  return (
    <svg className="ch-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {ys.map((v) => (
        <g key={v}>
          <line className="ch-grid" x1={pad.l} x2={width - pad.r} y1={py(v)} y2={py(v)} />
          <text className="ch-axis" x={pad.l - 8} y={py(v)} textAnchor="end" dominantBaseline="central">{fmt(v)}</text>
        </g>
      ))}
      <path className="ch-area" d={area} />
      <path className="ch-line" d={line} />
      {groups.map((g, i) => (
        <g key={g.key}>
          <title>{`${g.label}: ${fmt(g.value, avg)}`}</title>
          <circle className="ch-dot" cx={px(i)} cy={py(g.value)} r={4} />
          {i % every === 0 && <text className="ch-axis" x={px(i)} y={height - 10} textAnchor={groups.length > 1 && i === 0 ? 'start' : groups.length > 1 && i === groups.length - 1 ? 'end' : 'middle'}>{clip(g.label, every * step - 6 || plotW)}</text>}
        </g>
      ))}
    </svg>
  );
}

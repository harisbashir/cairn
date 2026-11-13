import type { Property, PropertyType, RollupFn } from '../../../shared/types.ts';

export type NumberFormat = NonNullable<Property['numberFormat']>;
export const NUMBER_FORMATS: { id: NumberFormat; label: string; sample: string }[] = [
  { id: 'plain', label: 'Number', sample: '1234.5' },
  { id: 'comma', label: 'Number with commas', sample: '1,234.5' },
  { id: 'percent', label: 'Percent', sample: '12.5%' },
  { id: 'currency', label: 'Currency', sample: '' },
];

// The currency follows the browser's region; there is no per-property currency in the schema.
const EURO = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
const BY_REGION: Record<string, string> = { GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IN: 'INR', JP: 'JPY', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', PK: 'PKR', AE: 'AED', SG: 'SGD', ZA: 'ZAR' };
function currencyCode(): string {
  const region = (navigator.language.split('-')[1] ?? '').toUpperCase();
  return EURO.has(region) ? 'EUR' : BY_REGION[region] ?? 'USD';
}
const CURRENCY = typeof navigator !== 'undefined' ? currencyCode() : 'USD';
NUMBER_FORMATS[3].sample = new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY }).format(1234.5);

export function fmtNumber(n: number, format: NumberFormat | undefined): string {
  if (!Number.isFinite(n)) return '';
  switch (format) {
    case 'comma': return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    case 'percent': return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    case 'currency': return new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY }).format(n);
    default: return String(Math.round(n * 100) / 100);
  }
}

export type ResultKind = 'number' | 'date' | 'checkbox' | 'text' | 'list';

/** What a computed property produces, so it can be rendered, filtered and aligned. */
export function resultKind(prop: Property): ResultKind | null {
  if (prop.type === 'rollup') {
    const fn = prop.rollup?.fn;
    return fn === 'show' ? 'list' : fn === 'earliest' || fn === 'latest' ? 'date' : 'number';
  }
  if (prop.type === 'formula') return prop.formula?.resultType ?? 'text';
  return null;
}

/** The type a property behaves as for filters and formulas (computed ones by their result). */
export function effectiveType(prop: Property): PropertyType {
  const k = resultKind(prop);
  if (!k) return prop.type;
  return k === 'list' ? 'multi_select' : k;
}

export const isComputed = (p: Pick<Property, 'type'>) => p.type === 'rollup' || p.type === 'formula';

export const ROLLUP_FNS: { fn: RollupFn; label: string; fits: (t: PropertyType | 'title') => boolean }[] = [
  { fn: 'count', label: 'Count rows', fits: () => true },
  { fn: 'count_values', label: 'Count values', fits: () => true },
  { fn: 'show', label: 'Show values', fits: () => true },
  { fn: 'sum', label: 'Sum', fits: (t) => t === 'number' },
  { fn: 'avg', label: 'Average', fits: (t) => t === 'number' },
  { fn: 'min', label: 'Smallest', fits: (t) => t === 'number' },
  { fn: 'max', label: 'Largest', fits: (t) => t === 'number' },
  { fn: 'earliest', label: 'Earliest date', fits: (t) => t === 'date' },
  { fn: 'latest', label: 'Latest date', fits: (t) => t === 'date' },
  { fn: 'percent_checked', label: 'Percent checked', fits: (t) => t === 'checkbox' },
];

const IMG = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
export const fileName = (url: string) => { try { return decodeURIComponent(url.split('/').pop() ?? url); } catch { return url; } };
export const isImage = (url: string) => IMG.test(fileName(url));

export function todayKey(): string { return new Date().toLocaleDateString('en-CA'); }

/** After the page saver flushes, fetch rows and this page again so rollups and formulas show their new values. */
export function refreshAfterSave(pageId: string) {
  // Lazy import keeps this file free of React Query for pure helpers.
  const done = () => {
    window.removeEventListener('cairn:saved', done);
    void import('../api.ts').then(({ qc }) => { qc.invalidateQueries({ queryKey: ['rows'] }); qc.invalidateQueries({ queryKey: ['page', pageId] }); });
  };
  window.addEventListener('cairn:saved', done);
  setTimeout(() => window.removeEventListener('cairn:saved', done), 10_000);
}

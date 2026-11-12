import type { Widget } from '../../../shared/types.ts';

export type WidgetConfig = Record<string, unknown>;

export interface WidgetProps {
  widget: Widget;
  editing: boolean;
  onChange: (config: WidgetConfig) => void;
}

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
export const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

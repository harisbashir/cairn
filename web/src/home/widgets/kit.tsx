import { useId, type ReactNode } from 'react';

/** Quiet inline message for empty, unconfigured or unavailable widgets. */
export function WidgetMessage({ children }: { children: ReactNode }) {
  return <div className="hm-msg">{children}</div>;
}

export function LoadError({ what }: { what: string }) {
  return <WidgetMessage>{what} can’t load right now. Cairn will try again when you come back to this tab.</WidgetMessage>;
}

/** A labelled select used in widget settings. Values are strings; map them in the caller. */
export function SettingSelect({ label, value, options, onChange, wide }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className={`hm-setting${wide ? ' wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select small" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function Settings({ children }: { children: ReactNode }) {
  return <div className="hm-settings">{children}</div>;
}

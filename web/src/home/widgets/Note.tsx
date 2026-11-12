import { Fragment, type ReactNode } from 'react';
import { str, type WidgetProps } from '../types.ts';
import { WidgetMessage } from './kit.tsx';

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

function linkify(line: string): ReactNode[] {
  return line.split(URL_RE).map((part, i) => (i % 2 === 1
    ? <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    : <Fragment key={i}>{part}</Fragment>));
}

export function NoteWidget({ widget, editing, onChange }: WidgetProps) {
  const text = str(widget.config.markdown);
  if (editing) {
    return (
      <textarea
        className="input hm-note-input" value={text} rows={6} maxLength={10000} aria-label="Note text"
        placeholder="Write anything: a welcome, a plan for the week, team norms…"
        onChange={(e) => onChange({ ...widget.config, markdown: e.target.value })}
      />
    );
  }
  if (!text.trim()) return <WidgetMessage>This note is empty. Select Customize to write something.</WidgetMessage>;
  return (
    <div className="hm-note-text">
      {text.trim().split(/\n{2,}/).map((para, i) => (
        <p key={i}>
          {para.split('\n').map((line, j) => <Fragment key={j}>{j > 0 && <br />}{linkify(line)}</Fragment>)}
        </p>
      ))}
    </div>
  );
}

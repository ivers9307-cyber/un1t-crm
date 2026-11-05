'use client'

// MIASETTINGS.3a — one message in the Messages section. Folded: the label
// (the toggle), a one-line preview (the value, or the default in muted text
// when blank) and the source tag. Open: the field itself. The toggle sits
// outside any disabled fieldset so a read-only viewer can still open a row;
// only the open field is disabled.

import AgentField from './AgentField'

const resolve = (v, ctx) => (typeof v === 'function' ? v(ctx || {}) : v)

export default function MessageRow({ field, ctx, value, tag, open, onToggle, onChange, disabled }) {
  const label = resolve(field.label, ctx)
  const blank = value == null || String(value).trim() === ''
  const preview = blank ? resolve(field.placeholder, ctx) : String(value)
  return (
    <div className="border-b border-un1t-border pb-3 last:border-b-0" data-testid={`message-row-${field.id}`}>
      {open ? (
        <div className="space-y-2">
          <button type="button" aria-expanded="true" onClick={onToggle}
            className="text-xs text-un1t-muted underline">
            Fold {label}
          </button>
          <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
            <AgentField field={field} ctx={ctx} value={value} onChange={onChange} tag={tag} />
          </fieldset>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button type="button" aria-expanded="false" onClick={onToggle}
            className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <span className="shrink-0 text-sm font-medium text-un1t-text">{label}</span>
            <span className={`truncate text-xs ${blank ? 'text-un1t-muted italic' : 'text-un1t-subtle'}`}
              data-testid="message-preview">
              {preview}
            </span>
          </button>
          {tag}
        </div>
      )}
    </div>
  )
}

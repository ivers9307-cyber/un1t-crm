'use client'

// MIASETTINGS.1c — one plain Mia setting, drawn from its registry entry
// (fields.js): text, textarea, number, select or checkbox. Both editors pass
// the entry fieldsFor resolved for their scope, so the label, help, limits
// and placeholder are the registry's. Custom editors (kind 'custom') are not
// drawn here.
//
// The value handed to onChange(path, value) is what the hand-written inputs
// handed the editor, so buildSavePayload sees the same thing:
//   text, textarea  the raw string typed (the payload trims)
//   number          '' -> null, else Number (0 kept)
//   select          '' -> null, else the option's value
//   checkbox        a boolean; checkedByDefault reads anything but false as on
//
// `tag` is the source tag beside the label (an inheritable field). Without
// one the label sits straight in the field's block, as a studio-only field's
// always did. `placeholder` overrides the entry's (an inherited number).

import { useId } from 'react'

const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'
const resolve = (v, ctx) => (typeof v === 'function' ? v(ctx || {}) : v)

function checkedOf(field, value) {
  return field.checkedByDefault ? value !== false : !!value
}

// A select shows a value it lists; anything else shows the first option (the
// booking mode showed 'auto' for anything but 'draft').
function selectValue(field, value) {
  const options = field.options || []
  const v = value == null ? '' : String(value)
  if (options.some(([o]) => o === v)) return v
  return options.length ? options[0][0] : ''
}

export default function AgentField({
  field, ctx, value, onChange, tag, disabled, error, placeholder: placeholderOverride, className,
}) {
  const id = useId()
  const path = field.paths?.[0] ?? field.id
  const label = resolve(field.label, ctx)
  const placeholder = placeholderOverride ?? resolve(field.placeholder, ctx)
  const help = field.help
  const errorId = `${id}-error`
  const invalid = error ? 'true' : undefined

  if (field.kind === 'checkbox') {
    return (
      <div className={className}>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-3">
            <input type="checkbox" className="h-4 w-4" disabled={disabled}
              checked={checkedOf(field, value)}
              onChange={(e) => onChange(path, e.target.checked)} />
            <span className="text-sm text-un1t-text font-medium">{label}</span>
          </label>
          {tag}
        </div>
        {help && <p className="text-xs text-un1t-muted mt-1 pl-7">{help}</p>}
      </div>
    )
  }

  const common = {
    id, className: inputCls, disabled, placeholder,
    'aria-invalid': invalid, 'aria-describedby': error ? errorId : undefined,
  }
  let control
  if (field.kind === 'textarea') {
    control = (
      <textarea {...common} rows={field.rows ?? 2} maxLength={field.maxLength}
        value={value ?? ''} onChange={(e) => onChange(path, e.target.value)} />
    )
  } else if (field.kind === 'number') {
    control = (
      <input {...common} type="number" min={field.min} max={field.max} step={field.step}
        value={value ?? ''}
        onChange={(e) => onChange(path, e.target.value === '' ? null : Number(e.target.value))} />
    )
  } else if (field.kind === 'select') {
    control = (
      <select {...common} value={selectValue(field, value)} onChange={(e) => onChange(path, e.target.value || null)}>
        {(field.options || []).map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    )
  } else {
    control = (
      <input {...common} type={field.inputType || undefined} maxLength={field.maxLength}
        value={value || ''} onChange={(e) => onChange(path, e.target.value)} />
    )
  }

  const labelEl = (
    <label htmlFor={id} className={`block text-sm font-medium text-un1t-text${tag === undefined ? ' mb-1' : ''}`}>{label}</label>
  )
  return (
    <div className={className}>
      {tag === undefined
        ? labelEl
        : <div className="flex items-center justify-between gap-2 mb-1">{labelEl}{tag}</div>}
      {control}
      {error && <p id={errorId} className="text-xs text-red-600 mt-1" role="alert">{error}</p>}
      {help && <p className="text-xs text-un1t-subtle mt-1">{help}</p>}
    </div>
  )
}

'use client'

// MIASETTINGS.1c / 2c — draws one plain field from the registry (fields.js)
// for the studio editor. fieldsFor applies each field's `when` (the booking
// link fields, the Hatch-only ones), so a field that does not apply here
// draws nothing. An inheritable field ('both': the organisation can set it
// too) carries its source tag; a studio-only one has none. A number field's
// placeholder is what it inherits when cleared (inheritedNumber).

import { valueAt } from '@/lib/agent/settings-overrides'
import { fieldsFor } from '../fields'
import AgentField from '../components/AgentField'

/**
 * @param {object} agent  useAgentSettings' return value
 * @returns {(id: string, extra?: object) => JSX.Element|null}
 */
export function fieldRenderer(agent) {
  const { settings, ctx, setField, sourceTag, inheritedNumber } = agent
  const registry = Object.fromEntries(fieldsFor('studio', null, ctx).map((f) => [f.id, f]))
  return function renderField(id, extra = {}) {
    const f = registry[id]
    if (!f) return null
    const path = f.paths[0]
    return (
      <AgentField key={id} field={f} ctx={ctx} value={valueAt(settings, path)} onChange={setField}
        tag={f.scope === 'both' ? sourceTag(f.paths) : undefined}
        placeholder={f.kind === 'number' && f.fallback != null ? inheritedNumber(path, f.fallback) : undefined}
        {...extra} />
    )
  }
}

/** The registry entry a custom editor reads its label, help and options from. */
export function registryField(id, ctx) {
  return fieldsFor('studio', null, ctx).find((f) => f.id === id) || null
}

// The panel every section's settings sit in.
export const CARD = 'border border-un1t-border rounded-lg p-5'
export const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

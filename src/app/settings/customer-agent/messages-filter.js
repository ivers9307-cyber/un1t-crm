// MIASETTINGS.3a — which message fields the Messages section shows for a
// search and the "Changed only" toggle. The query matches the label, the help
// and the current value (case-insensitive, trimmed); an empty query matches
// all. "Changed only" keeps fields the studio has set itself (overridden).

import { valueAt, isOverridden } from '@/lib/agent/settings-overrides'

const resolve = (v, ctx) => (typeof v === 'function' ? v(ctx || {}) : v)

export function filterMessages(fields, { query = '', changedOnly = false, settings, overridden, ctx } = {}) {
  const q = String(query || '').trim().toLowerCase()
  return fields.filter((f) => {
    if (changedOnly && !f.paths.some((p) => isOverridden(overridden || [], p))) return false
    if (!q) return true
    const value = f.paths[0] ? valueAt(settings, f.paths[0]) : ''
    const hay = [resolve(f.label, ctx), f.help, value == null ? '' : String(value)]
    return hay.some((s) => String(s || '').toLowerCase().includes(q))
  })
}

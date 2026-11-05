// MIASETTINGS.3a — which message fields the Messages section shows for a
// search and the "Changed only" toggle. The query matches the label, the help
// and the current value (case-insensitive, trimmed); an empty query matches
// all (an open row in keepIds always stays). A blank value searches the field's
// default text. "Changed only" keeps fields the studio has set itself (overridden).

import { valueAt, isOverridden } from '@/lib/agent/settings-overrides'

const resolve = (v, ctx) => (typeof v === 'function' ? v(ctx || {}) : v)

export function filterMessages(fields, { query = '', changedOnly = false, settings, overridden, ctx, keepIds } = {}) {
  const q = String(query || '').trim().toLowerCase()
  return fields.filter((f) => {
    // A row that is open stays listed while it is typed in, even if the edit stops it matching.
    if (keepIds && keepIds.has(f.id)) return true
    if (changedOnly && !f.paths.some((p) => isOverridden(overridden || [], p))) return false
    if (!q) return true
    const value = f.paths[0] ? valueAt(settings, f.paths[0]) : ''
    const blank = value == null || String(value).trim() === ''
    // A blank value shows the default, so the default text is searchable too.
    const hay = [resolve(f.label, ctx), f.help, blank ? resolve(f.placeholder, ctx) : String(value)]
    return hay.some((s) => String(s || '').toLowerCase().includes(q))
  })
}

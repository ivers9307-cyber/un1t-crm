// DUNNING.6 / PAYLINK.8 — gallery templates can name a WhatsApp template
// instead of carrying a location-specific whatsapp_templates uuid. At
// install time the name resolves against the installing location's APPROVED
// templates. The install route calls missingWhatsappTemplateNames FIRST and
// refuses the install outright when it finds one — installing with a null
// template id used to produce a run whose WhatsApp steps all silently
// skipped, caught only later (if at all) by pre-publish validation. Pure.

/**
 * @param {Array<object>} steps   gallery template steps
 * @param {Array<{ id:string, name:string, status?:string }>} rows  the location's whatsapp_templates
 * @returns {Array<object>} steps with whatsapp_template_id filled and the name key removed
 */
export function resolveWhatsappTemplateIds(steps, rows) {
  const byName = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.name && String(r.status || '').toUpperCase() === 'APPROVED') byName.set(r.name, r.id)
  }
  return (Array.isArray(steps) ? steps : []).map((s) => {
    if (s?.step_type !== 'whatsapp' || !('whatsapp_template_name' in (s || {}))) return s
    const { whatsapp_template_name: name, ...rest } = s
    const id = rest.whatsapp_template_id || byName.get(name) || null
    return { ...rest, whatsapp_template_id: id }
  })
}

/**
 * PAYLINK.8 — the WhatsApp template NAMES a gallery template asks for that
 * are not APPROVED at the installing location, distinct, in step order. A
 * step that already carries a whatsapp_template_id is never "missing". The
 * install route refuses on a non-empty list: installing with a null template
 * id used to produce a run whose WhatsApp steps all skipped.
 */
export function missingWhatsappTemplateNames(steps, rows) {
  const approved = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.name && String(r.status || '').toUpperCase() === 'APPROVED') approved.add(r.name)
  }
  const out = []
  for (const s of Array.isArray(steps) ? steps : []) {
    if (s?.step_type !== 'whatsapp' || s.whatsapp_template_id) continue
    const name = s.whatsapp_template_name
    if (name && !approved.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

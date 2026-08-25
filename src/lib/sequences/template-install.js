// DUNNING.6 — gallery templates can name a WhatsApp template instead of
// carrying a location-specific whatsapp_templates uuid. At install time the
// name resolves against the installing location's APPROVED templates; a miss
// leaves the id null, and the pre-publish validation ("WhatsApp needs a
// template") makes the operator pick one. Pure.

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

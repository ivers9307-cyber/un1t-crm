// src/lib/whatsapp-template-sync.js
// WAORGNUMBER.2 (design R5) — pure planner for "Sync at studio S" of
// GET /api/whatsapp/templates?sync=true. No IO: the route fetches Meta's list for
// ONE WABA and every whatsapp_templates row on that WABA (any studio), calls this,
// and applies the plan.
//
//   - a Meta template that matches a row S owns          -> update that row
//   - ... that matches a row another studio owns         -> skipped 'other_studio'
//   - ... that matches no row, S is the number's home    -> insert (adopt) at S
//   - ... that matches no row, S is not the home studio  -> skipped 'unowned_not_home'
//     (syncing at Hatch never copies Stillorgan's templates into Hatch)
//
// Match key: meta_template_id first (Meta's ids are globally unique, mig 744), else
// (name, language). The id wins even if another row shares the name.

const nameKey = (name, language) => `${name}\u0000${language ?? ''}`

export function planTemplateSync({ metaTemplates, rowsOnWaba, studioId, isHomeStudio, wabaId }) {
  const byMetaId = new Map()
  const byName = new Map()
  for (const r of rowsOnWaba || []) {
    if (r.meta_template_id != null && !byMetaId.has(String(r.meta_template_id))) byMetaId.set(String(r.meta_template_id), r)
    const k = nameKey(r.name, r.language)
    if (!byName.has(k)) byName.set(k, r)
  }

  const updates = []
  const inserts = []
  const skipped = []

  for (const mt of metaTemplates || []) {
    const row = {
      meta_template_id: mt.id,
      name: mt.name,
      language: mt.language,
      category: mt.category,
      components: mt.components || [],
      status: mt.status,
      rejection_reason: mt.rejected_reason || null,
      location_id: studioId,
      business_account_id: wabaId,
    }
    const match = (mt.id != null && byMetaId.get(String(mt.id))) || byName.get(nameKey(mt.name, mt.language)) || null

    if (match) {
      if (match.location_id === studioId) updates.push({ id: match.id, row })
      else skipped.push({ name: mt.name, language: mt.language, ownerLocationId: match.location_id ?? null, reason: 'other_studio' })
    } else if (isHomeStudio) {
      inserts.push(row)
    } else {
      skipped.push({ name: mt.name, language: mt.language, ownerLocationId: null, reason: 'unowned_not_home' })
    }
  }

  return { updates, inserts, skipped }
}

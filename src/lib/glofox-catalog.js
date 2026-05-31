// GLOFOX-CATALOG — pure helpers for the studio membership catalog.
//
// Source: Glofox GET /2.0/memberships → { data: [ membership ] }, where
// each membership is:
//   { _id, name ("N) The X Membership..."), description (terms text),
//     active, type, plans: [ { code, price, type, name, ... } ], ... }
//
// parseMembershipCatalog turns that into rows for the glofox_memberships
// table. matchCatalogToPlan resolves a member's stored plan name to its
// catalog row (and thus its description). Both pure — unit-tested.

/** Strip Glofox's "N) " sort-order prefix from a catalog name. */
export function stripPlanPrefix(name) {
  if (typeof name !== 'string') return null
  const cleaned = name.replace(/^\d+\)\s*/, '').trim()
  return cleaned || null
}

/**
 * Parse a /2.0/memberships response body into catalog rows. Pure.
 * @param {object} body         the parsed JSON ({ data: [...] } or an array)
 * @param {string} locationId   CRM location uuid to stamp on each row
 * @returns {Array<object>} rows shaped for the glofox_memberships table
 */
export function parseMembershipCatalog(body, locationId) {
  const list = Array.isArray(body) ? body
    : (body && Array.isArray(body.data) ? body.data : [])
  const rows = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    const id = m._id || m.id
    if (!id) continue
    const plans = Array.isArray(m.plans) ? m.plans : []
    const planNames = plans
      .map(p => (p && typeof p.name === 'string' ? p.name.trim() : null))
      .filter(Boolean)
    // Best-effort headline price: the first plan's price (in euros) → cents.
    const firstPrice = plans.find(p => Number.isFinite(Number(p?.price)))
    const priceCents = firstPrice != null ? Math.round(Number(firstPrice.price) * 100) : null
    const description = typeof m.description === 'string' && m.description.trim()
      ? m.description.trim()
      : null
    rows.push({
      glofox_membership_id: String(id),
      location_id: locationId,
      name: typeof m.name === 'string' ? m.name : null,
      name_clean: stripPlanPrefix(m.name),
      description,
      membership_type: typeof m.type === 'string' ? m.type : null,
      active: typeof m.active === 'boolean' ? m.active : null,
      plan_names: planNames,
      price_cents: priceCents,
      plans,
    })
  }
  return rows
}

/**
 * Resolve a member's stored plan to its catalog row. Pure.
 * Matches (case-insensitive) on, in order:
 *   1. catalog.name_clean === planFull   (the catalog/promo name)
 *   2. catalog.name_clean === plan       (clean name)
 *   3. plan ∈ catalog.plan_names         (the plans[].name)
 * Returns the matching row or null.
 *
 * @param {Array<object>} catalog  rows from glofox_memberships
 * @param {{plan?:string|null, planFull?:string|null}} member
 */
export function matchCatalogToPlan(catalog, { plan, planFull } = {}) {
  if (!Array.isArray(catalog) || catalog.length === 0) return null
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')
  const p = norm(plan)
  const pf = norm(planFull)
  if (!p && !pf) return null

  for (const row of catalog) {
    const nc = norm(row?.name_clean)
    if (pf && nc && nc === pf) return row
  }
  for (const row of catalog) {
    const nc = norm(row?.name_clean)
    if (p && nc && nc === p) return row
  }
  for (const row of catalog) {
    const names = Array.isArray(row?.plan_names) ? row.plan_names.map(norm) : []
    if (p && names.includes(p)) return row
  }
  return null
}

// ── IO: fetch the catalog from Glofox + upsert into glofox_memberships ──
// Imported lazily to keep the pure helpers above dependency-free for the
// Node test env. Returns { ok, count, error }.
export async function syncMembershipCatalog(db, locationId, creds) {
  if (!db || !locationId || !creds?.branchId) return { ok: false, count: 0, error: 'missing args' }
  const { glofoxFetch } = await import('./glofox')
  let body
  try {
    const r = await glofoxFetch(creds, '/2.0/memberships')
    if (!r.ok) return { ok: false, count: 0, error: `Glofox HTTP ${r.status}` }
    body = await r.json()
  } catch (e) {
    return { ok: false, count: 0, error: e?.message || 'network error' }
  }
  const rows = parseMembershipCatalog(body, locationId).map(r => ({ ...r, synced_at: new Date().toISOString() }))
  if (rows.length === 0) return { ok: true, count: 0, error: null }
  const { error } = await db.from('glofox_memberships').upsert(rows, { onConflict: 'glofox_membership_id' })
  if (error) return { ok: false, count: 0, error: error.message }
  return { ok: true, count: rows.length, error: null }
}

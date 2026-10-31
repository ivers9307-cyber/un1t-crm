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
      // GLOFOXPRIVATE.1 — the dashboard's "Private" toggle (mig 796). The list
      // body may omit it (everything the list returns is public); the by-id
      // body carries it. null = the body did not say.
      private: typeof m.private === 'boolean' ? m.private : null,
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
  // GLOFOXPRIVATE.1 — everything the list returns is public (a body that does
  // not say so is still a list row), and a learned private row is never in
  // the list, so this upsert can never flip one back.
  const rows = parseMembershipCatalog(body, locationId).map(r => ({
    ...r, private: r.private ?? false, discovered_via: 'list', synced_at: new Date().toISOString(),
  }))
  if (rows.length === 0) return { ok: true, count: 0, error: null }
  const { error } = await db.from('glofox_memberships').upsert(rows, { onConflict: 'glofox_membership_id' })
  if (error) return { ok: false, count: 0, error: error.message }
  return { ok: true, count: rows.length, error: null }
}

// ── GLOFOXPRIVATE.1 — learning the memberships the list hides ──────────────
//
// Glofox's GET /2.0/memberships returns only PUBLIC memberships; one with the
// dashboard's "Private" toggle on is readable by id (GET /2.0/memberships/{id},
// verified 2026-10-31 on "1) The Elites Trial") but never listed. So the sync
// records every membership id it meets on a member record (member.membership
// ._id, present on the single-member GET) by reading it by id, and the pickers
// list the live public set plus these learned rows (mig 796).

/** A row refreshed this recently is not read again from Glofox. */
export const LEARN_FRESH_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Record the membership a member holds in glofox_memberships when the
 * catalogue does not hold a fresh row for it. One cheap DB read guards the
 * Glofox call; `cache` is the sync run's membership Map (fetchMembershipResult
 * memoises by id in it, and `learned:<id>` marks an id this run has settled).
 * Never throws; the caller's sync already wrote the contact.
 *
 * @returns {Promise<{ok:boolean, action:string, private?:boolean, error?:string}>}
 */
export async function learnMembershipById(db, locationId, creds, membershipId, cache = null) {
  const id = String(membershipId || '').trim()
  if (!db || !locationId || !creds || !id) return { ok: false, action: 'skipped' }
  const key = `learned:${id}`
  if (cache && cache.has(key)) return { ok: true, action: 'cached' }
  try {
    const { data: row, error: readErr } = await db.from('glofox_memberships')
      .select('glofox_membership_id, synced_at, private')
      .eq('glofox_membership_id', id)
      .maybeSingle()
    if (readErr) return { ok: false, action: 'read_failed', error: readErr.message }
    const syncedAt = row?.synced_at ? Date.parse(row.synced_at) : NaN
    if (row && typeof row.private === 'boolean' && Number.isFinite(syncedAt) && syncedAt > Date.now() - LEARN_FRESH_MS) {
      if (cache) cache.set(key, true)
      return { ok: true, action: 'fresh', private: row.private }
    }
    const { fetchMembershipResult } = await import('./glofox')
    const r = await fetchMembershipResult(creds, id, cache)
    if (!r.ok) return { ok: false, action: 'fetch_failed' }
    if (!r.membership) {
      // A 404 is an answer: nothing to learn, and nothing to ask again this run.
      if (cache) cache.set(key, true)
      return { ok: true, action: 'not_found' }
    }
    const [parsed] = parseMembershipCatalog([r.membership], locationId)
    if (!parsed) return { ok: false, action: 'unparsable' }
    const { error } = await db.from('glofox_memberships').upsert(
      { ...parsed, discovered_via: 'member_detail', synced_at: new Date().toISOString() },
      { onConflict: 'glofox_membership_id' },
    )
    if (error) return { ok: false, action: 'write_failed', error: error.message }
    if (cache) cache.set(key, true)
    return { ok: true, action: 'learned', private: parsed.private === true }
  } catch (e) {
    return { ok: false, action: 'threw', error: e?.message || 'threw' }
  }
}

/**
 * The learned PRIVATE memberships at a studio, in the shape
 * listGlofoxMemberships() returns ({ _id, name, private, plans[] }), minus the
 * ids in `excludeIds` (the live list, so a membership made public later is
 * not shown twice). A failed read answers `{ rows: [], error }`: the picker
 * still shows the live list and says the private ones could not be read.
 */
export async function learnedPrivateMemberships(db, locationId, excludeIds = new Set()) {
  if (!db || !locationId) return { rows: [], error: 'missing args' }
  try {
    const { data, error } = await db.from('glofox_memberships')
      .select('glofox_membership_id, name, active, plans, private')
      .eq('location_id', locationId)
      .eq('private', true)
      .order('name')
    if (error) return { rows: [], error: error.message }
    const rows = (Array.isArray(data) ? data : [])
      .filter(r => r?.glofox_membership_id && !excludeIds.has(r.glofox_membership_id))
      .map(r => ({
        _id: String(r.glofox_membership_id),
        name: String(r.name || ''),
        active: r.active === true,
        private: true,
        plans: (Array.isArray(r.plans) ? r.plans : []).map(p => ({
          code: String(p?.code || ''),
          type: String(p?.type || ''),
          price: Number(p?.price) || 0,
          name: String(p?.name || ''),
        })).filter(p => p.code),
      }))
    return { rows, error: null }
  } catch (e) {
    return { rows: [], error: e?.message || 'threw' }
  }
}

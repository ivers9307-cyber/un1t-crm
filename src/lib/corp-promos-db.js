// WAYSIN.2 — the corp_promos readers (mig 816). SERVER-ONLY by convention:
// the rows carry the Glofox plan binding, so no client component may import
// this module (src/lib/corp-promos.js, which a client imports, holds only the
// seed and the words).
//
// Every read takes a service-role client and is scoped by location_id. A
// failed read is { ok: false, error }, never "no promos": the caller judges it.

/** @typedef {{ membershipId: string, planCode: string, planName: string | null }} CorpPromoGlofoxPlan */
/** @typedef {{ id: string, locationId: string, key: string, name: string, platform: 'un1t_online'|'glofox', credits: number, expiresInDays: number, live: boolean, tag: string, leadSource: string, glofox: CorpPromoGlofoxPlan | null }} CorpPromoRow */

// Named columns: check:select-columns resolves them against mig 816.
export const CORP_PROMO_COLUMNS = 'id, location_id, key, name, platform, credits, expires_in_days, live, tag, lead_source, glofox_membership_id, glofox_plan_code, glofox_plan_name'
const READ_PAGE = 1000

const blank = (v) => typeof v !== 'string' || v.trim() === ''

/**
 * A corp_promos row with the camelCase accessors the fulfilment code reads
 * (promo.credits, promo.expiresInDays, promo.name, promo.key, promo.tag,
 * promo.leadSource). glofox is the plan binding, or null when its membership
 * id or plan code is blank.
 * @returns {CorpPromoRow | null}
 */
export function promoView(row) {
  if (!row || typeof row !== 'object') return null
  const glofox = blank(row.glofox_membership_id) || blank(row.glofox_plan_code)
    ? null
    : {
      membershipId: row.glofox_membership_id.trim(),
      planCode: row.glofox_plan_code.trim(),
      planName: blank(row.glofox_plan_name) ? null : row.glofox_plan_name.trim(),
    }
  return {
    id: row.id,
    locationId: row.location_id,
    key: row.key,
    name: row.name,
    platform: row.platform,
    credits: row.credits,
    expiresInDays: row.expires_in_days,
    live: row.live === true,
    tag: row.tag,
    leadSource: row.lead_source,
    glofox,
  }
}

const readError = (error) => ({ ok: false, error: error?.message || String(error || 'corp_promos read failed') })

/**
 * The studio's promo with `key`, or null when that studio has none by that key.
 * @returns {Promise<{ ok: true, promo: CorpPromoRow | null } | { ok: false, error: string }>}
 */
export async function readCorpPromo(db, { locationId, key } = {}) {
  if (!locationId) return { ok: false, error: 'location_required' }
  if (typeof key !== 'string' || key.trim() === '') return { ok: true, promo: null }
  try {
    // (location_id, key) is unique (corp_promos_location_key_unique): at most one row.
    const { data, error } = await db.from('corp_promos')
      .select(CORP_PROMO_COLUMNS)
      .eq('location_id', locationId)
      .eq('key', key)
      .maybeSingle()
    if (error) return readError(error)
    return { ok: true, promo: data ? promoView(data) : null }
  } catch (err) {
    return readError(err)
  }
}

/**
 * Every promo at the studio (only the live ones with liveOnly), ordered by key,
 * paged past the 1,000-row cap.
 * @returns {Promise<{ ok: true, promos: CorpPromoRow[] } | { ok: false, error: string }>}
 */
export async function listCorpPromos(db, { locationId, liveOnly = false } = {}) {
  if (!locationId) return { ok: false, error: 'location_required' }
  const promos = []
  try {
    for (let from = 0; ; from += READ_PAGE) {
      let q = db.from('corp_promos').select(CORP_PROMO_COLUMNS).eq('location_id', locationId)
      if (liveOnly) q = q.eq('live', true)
      const { data, error } = await q.order('key', { ascending: true }).range(from, from + READ_PAGE - 1)
      if (error) return readError(error)
      const rows = Array.isArray(data) ? data : []
      for (const r of rows) promos.push(promoView(r))
      if (rows.length < READ_PAGE) return { ok: true, promos }
    }
  } catch (err) {
    return readError(err)
  }
}

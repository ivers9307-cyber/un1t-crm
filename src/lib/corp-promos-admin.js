// WAYSIN.4 — the rules the promo settings routes share
// (/api/locations/[id]/corp-promos[/promoId]). Server-side only by use; holds
// no plan id, it only judges what an operator sent.

/** The promo platform a studio's membership_source runs, or null for none. */
export function promoPlatformFor(membershipSource) {
  if (membershipSource === 'glofox') return 'glofox'
  if (membershipSource === 'un1t_online' || membershipSource === 'un1t') return 'un1t_online'
  return null
}

export const GLOFOX_PROMO_FIELDS = Object.freeze(['glofox_membership_id', 'glofox_plan_code', 'glofox_plan_name'])

const blank = (v) => typeof v !== 'string' || v.trim() === ''

/**
 * Judge a promo's Glofox binding against its platform. A Glofox promo needs
 * all three fields (mig 816's CHECK); a un1t.online promo carries none.
 * `fields` is the full set the row will hold after the write.
 * @returns {{ ok: true, glofox: Record<string, string|null> } | { ok: false, status: number, code: string, error: string }}
 */
export function judgeGlofoxBinding(platform, fields) {
  if (platform === 'glofox') {
    if (GLOFOX_PROMO_FIELDS.some((k) => blank(fields?.[k]))) {
      return { ok: false, status: 400, code: 'glofox_plan_missing', error: 'A Glofox promo needs its membership id, plan code and plan name.' }
    }
    return { ok: true, glofox: Object.fromEntries(GLOFOX_PROMO_FIELDS.map((k) => [k, fields[k].trim()])) }
  }
  if (GLOFOX_PROMO_FIELDS.some((k) => !blank(fields?.[k]))) {
    return { ok: false, status: 400, code: 'glofox_not_applicable', error: 'This studio books through un1t.online; Glofox plan fields do not apply.' }
  }
  return { ok: true, glofox: Object.fromEntries(GLOFOX_PROMO_FIELDS.map((k) => [k, null])) }
}

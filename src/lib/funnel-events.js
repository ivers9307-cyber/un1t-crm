// funnel-events.js — validate/normalize a /start funnel step event for the
// public capture endpoint (/api/public/funnel-event). Pure; the route handles
// location resolution + the DB insert. Low-trust input (public endpoint), so
// every field is allowlisted/capped and an unknown step is rejected.
export const VALID_STEPS = [
  'view',
  'path_class',
  'path_consult',
  'details',
  'slots_view',
  'booked_class',
  'booked_consult',
]

const cap = (v, n = 200) => (v == null ? null : String(v).slice(0, n))

export function parseFunnelEvent(body = {}) {
  if (!VALID_STEPS.includes(body.step)) return null
  const session_id = cap(body.session_id)
  if (!session_id) return null
  const ad_external_id = cap(body.ad_external_id)
  return {
    funnel: cap(body.funnel) || 'start',
    step: body.step,
    session_id,
    ad_external_id,
    ad_provider: cap(body.ad_provider) || (ad_external_id ? 'meta' : null),
    utm_campaign: cap(body.utm_campaign),
    utm_content: cap(body.utm_content),
    utm_term: cap(body.utm_term),
    meta: body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : {},
  }
}
